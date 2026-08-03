from __future__ import annotations

import asyncio
import json
import os
import stat
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import pytest
from notebooklm.exceptions import AuthError, ServerError

from diandianreading.domain import CredentialRef, DiandianError, ErrorCode, UnsafePathError
from diandianreading.infrastructure.fakes import FakeNotebookLMClientFactory
from diandianreading.infrastructure.notebooklm import (
    CredentialPathResolver,
    NotebookLMAdapter,
    NotebookLMAdapterConfig,
)
from diandianreading.infrastructure.notebooklm import adapter as adapter_module
from diandianreading.infrastructure.notebooklm.protocols import NotebookLMClientProtocol
from diandianreading.infrastructure.persistence import (
    SQLiteDatabase,
    SQLiteKnowledgeMappingRepository,
)
from diandianreading.infrastructure.storage import LocalFileStore


class SyncProgressSink:
    job_id = "sync-progress"

    def __init__(self) -> None:
        self.called = False

    def emit(self, event) -> None:
        del event
        self.called = True


class RaisingProgressSink:
    job_id = "raising-progress"

    async def emit(self, event) -> None:
        del event
        raise RuntimeError("observer failed")


class FailingOpenFactory:
    @asynccontextmanager
    async def open(self, storage_path) -> AsyncIterator[NotebookLMClientProtocol]:
        del storage_path
        raise AuthError("secret auth payload")
        yield  # pragma: no cover


class FailingCloseFactory:
    def __init__(self, delegate: FakeNotebookLMClientFactory) -> None:
        self.delegate = delegate

    @asynccontextmanager
    async def open(self, storage_path) -> AsyncIterator[NotebookLMClientProtocol]:
        async with self.delegate.open(storage_path) as client:
            yield client
        raise ServerError("secret close payload", status_code=503)


def build_adapter(tmp_path, *, factory=None, staging_root=None):
    credential = CredentialRef("notebooklm", "security")
    resolver = CredentialPathResolver(tmp_path / "credentials")
    storage_state = resolver.prepare_profile_directory(credential) / "storage_state.json"
    storage_state.write_text(json.dumps({"cookies": [], "origins": []}), encoding="utf-8")
    if os.name != "nt":
        storage_state.chmod(0o600)
    database = SQLiteDatabase(tmp_path / "state" / "app.sqlite3")
    database.migrate()
    adapter = NotebookLMAdapter(
        credential_resolver=resolver,
        file_store=LocalFileStore(tmp_path / "objects"),
        mappings=SQLiteKnowledgeMappingRepository(database),
        staging_root=staging_root or (tmp_path / "staging"),
        client_factory=factory or FakeNotebookLMClientFactory(),
    )
    return adapter, credential


def test_adapter_config_and_unopened_close_are_bounded(tmp_path) -> None:
    with pytest.raises(ValueError, match="timeouts"):
        NotebookLMAdapterConfig(source_wait_timeout=0)
    adapter, _ = build_adapter(tmp_path)
    asyncio.run(adapter.aclose())


def test_progress_observers_cannot_break_adapter_work(tmp_path) -> None:
    sync_sink = SyncProgressSink()

    async def scenario() -> None:
        await NotebookLMAdapter._emit_progress(
            sync_sink,  # type: ignore[arg-type]
            step="uploading",
            current=1,
            total=1,
            message="done",
        )
        await NotebookLMAdapter._emit_progress(
            RaisingProgressSink(),  # type: ignore[arg-type]
            step="uploading",
            current=1,
            total=1,
            message="done",
        )

    asyncio.run(scenario())
    assert sync_sink.called


def test_download_validation_rejects_missing_empty_and_symlink_outputs(tmp_path) -> None:
    missing = tmp_path / "missing"
    with pytest.raises(DiandianError) as absent:
        NotebookLMAdapter._validate_download(missing)
    assert absent.value.code is ErrorCode.CONVERSION_FAILED

    empty = tmp_path / "empty"
    empty.touch(mode=0o600)
    with pytest.raises(DiandianError) as zero_bytes:
        NotebookLMAdapter._validate_download(empty)
    assert zero_bytes.value.code is ErrorCode.CONVERSION_FAILED

    regular = tmp_path / "regular"
    regular.write_bytes(b"generated")
    NotebookLMAdapter._validate_download(regular)
    if os.name != "nt":
        assert stat.S_IMODE(regular.stat().st_mode) == 0o600

    if hasattr(os, "symlink"):
        link = tmp_path / "download-link"
        link.symlink_to(regular)
        with pytest.raises(UnsafePathError, match="regular non-symlink"):
            NotebookLMAdapter._validate_download(link)


def test_staging_cleanup_is_confined_and_fails_closed_without_path_details(
    tmp_path, monkeypatch
) -> None:
    staging_root = tmp_path / "staging"
    adapter, _ = build_adapter(tmp_path, staging_root=staging_root)
    temporary = staging_root / "artifact-test"
    temporary.mkdir(mode=0o700)

    with pytest.raises(UnsafePathError, match="escaped"):
        adapter._cleanup_staging_directory(tmp_path / "outside")

    def fail_cleanup(path) -> None:
        raise OSError(f"secret staging path: {path}")

    monkeypatch.setattr(adapter_module.shutil, "rmtree", fail_cleanup)
    with pytest.raises(DiandianError) as cleanup_failure:
        adapter._cleanup_staging_directory(temporary)
    assert cleanup_failure.value.code is ErrorCode.UNEXPECTED
    assert str(tmp_path) not in cleanup_failure.value.public_message


def test_staging_root_rejects_symlinks_non_directories_and_open_permissions(tmp_path) -> None:
    if hasattr(os, "symlink"):
        outside = tmp_path / "outside"
        outside.mkdir(mode=0o700)
        linked = tmp_path / "linked-staging"
        linked.symlink_to(outside, target_is_directory=True)
        with pytest.raises(UnsafePathError, match="cannot contain symlinks"):
            build_adapter(tmp_path / "linked-case", staging_root=linked)

    file_root = tmp_path / "staging-file"
    file_root.write_text("not a directory", encoding="utf-8")
    with pytest.raises(UnsafePathError, match="private directory"):
        build_adapter(tmp_path / "file-case", staging_root=file_root)

    if os.name != "nt":
        permissive = tmp_path / "permissive"
        permissive.mkdir(mode=0o755)
        permissive.chmod(0o755)
        with pytest.raises(UnsafePathError, match="permissions"):
            build_adapter(tmp_path / "permission-case", staging_root=permissive)


def test_adapter_rejects_cross_event_loop_reuse_after_clean_close(tmp_path) -> None:
    adapter, credential = build_adapter(tmp_path)

    async def first_loop() -> None:
        health = await adapter.health_check(credential)
        assert health.healthy
        await adapter.aclose()

    asyncio.run(first_loop())
    with pytest.raises(DiandianError) as cross_loop:
        asyncio.run(adapter.health_check(credential))
    assert cross_loop.value.code is ErrorCode.VALIDATION


def test_client_open_and_close_failures_are_mapped_without_provider_details(tmp_path) -> None:
    open_adapter, credential = build_adapter(
        tmp_path / "open",
        factory=FailingOpenFactory(),
    )
    with pytest.raises(DiandianError) as open_failure:
        asyncio.run(open_adapter.health_check(credential))
    assert open_failure.value.code is ErrorCode.AUTH_REQUIRED
    assert "secret" not in open_failure.value.public_message.lower()

    close_adapter, close_credential = build_adapter(
        tmp_path / "close",
        factory=FailingCloseFactory(FakeNotebookLMClientFactory()),
    )

    async def close_scenario() -> None:
        await close_adapter.health_check(close_credential)
        await close_adapter.aclose()

    with pytest.raises(DiandianError) as close_failure:
        asyncio.run(close_scenario())
    assert close_failure.value.code is ErrorCode.REMOTE_UNAVAILABLE
    assert "secret" not in close_failure.value.public_message.lower()
