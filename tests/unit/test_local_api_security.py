from __future__ import annotations

import asyncio
import base64
import hmac
import json
import os
import stat
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast

import pytest

from diandianreading.infrastructure.local_api import (
    INSTALL_TOKEN_FILENAME,
    BootstrapNonce,
    BrowserSessionCredentials,
    InstallTokenAuthenticationError,
    InstallTokenNotInitializedError,
    InstallTokenStore,
    InstallTokenStoreError,
    InvalidInstallTokenFileError,
    LocalApiSecurityConfig,
    LocalApiSecurityConfigurationError,
    UnsafeInstallTokenStoreError,
)
from diandianreading.interfaces.web.http_security import (
    LocalHttpConfig,
    SseConnectionLimiter,
)


def _write_private(path: Path, payload: str) -> None:
    _ = path.write_text(payload, encoding="utf-8")
    if os.name != "nt":
        path.chmod(0o600)


def test_install_token_initialization_is_explicit_private_versioned_and_repr_hidden(
    tmp_path: Path,
) -> None:
    root = tmp_path / "credentials" / "local-api"
    store = InstallTokenStore(root)

    with pytest.raises(InstallTokenNotInitializedError) as missing:
        _ = store.read_for_cli()
    assert str(tmp_path) not in str(missing.value)

    initial = store.ensure_initial()
    document = cast(
        dict[str, object],
        json.loads((root / INSTALL_TOKEN_FILENAME).read_text(encoding="utf-8")),
    )
    encoded = initial.token.encode("ascii")
    decoded = base64.urlsafe_b64decode(encoded + b"=" * ((4 - len(encoded) % 4) % 4))

    assert document == {"version": 1, "generation": 1, "token": initial.token}
    assert len(decoded) >= 32
    assert initial.token not in repr(initial)
    assert store.ensure_initial() == initial
    assert store.read_for_cli() == initial
    assert store.verify_bearer(initial.token).generation == 1
    assert store.verify_authorization_header(f"Bearer {initial.token}").generation == 1
    if os.name != "nt":
        assert stat.S_IMODE(root.stat().st_mode) == 0o700
        assert stat.S_IMODE(store.path.stat().st_mode) == 0o600
        assert root.stat().st_uid == os.getuid()
        assert store.path.stat().st_uid == os.getuid()

    with pytest.raises(InstallTokenAuthenticationError) as wrong:
        _ = store.verify_bearer("not-the-install-token")
    assert initial.token not in str(wrong.value)
    assert str(tmp_path) not in str(wrong.value)


@pytest.mark.skipif(os.name == "nt", reason="POSIX ownership and mode checks")
def test_install_token_store_rejects_public_modes_and_symlinks(tmp_path: Path) -> None:
    root = tmp_path / "credentials"
    store = InstallTokenStore(root)
    _ = store.ensure_initial()

    root.chmod(0o755)
    with pytest.raises(UnsafeInstallTokenStoreError) as unsafe_root:
        _ = store.read_for_cli()
    assert str(root) not in str(unsafe_root.value)
    root.chmod(0o700)

    store.path.chmod(0o644)
    with pytest.raises(UnsafeInstallTokenStoreError):
        _ = store.read_for_cli()
    store.path.chmod(0o600)

    outside = tmp_path / "outside-token.json"
    _write_private(
        outside,
        json.dumps({"version": 1, "generation": 1, "token": "A" * 43}),
    )
    store.path.unlink()
    store.path.symlink_to(outside)
    with pytest.raises(UnsafeInstallTokenStoreError):
        _ = store.read_for_cli()

    linked_root = tmp_path / "linked-root"
    outside_root = tmp_path / "outside-root"
    outside_root.mkdir(mode=0o700)
    linked_root.symlink_to(outside_root, target_is_directory=True)
    with pytest.raises(UnsafeInstallTokenStoreError):
        _ = InstallTokenStore(linked_root)


def test_install_token_store_fails_closed_for_corrupt_oversized_and_missing_files(
    tmp_path: Path,
) -> None:
    store = InstallTokenStore(tmp_path / "credentials")
    initial = store.ensure_initial()

    _write_private(store.path, "not-json")
    with pytest.raises(InvalidInstallTokenFileError) as corrupt:
        _ = store.read_for_cli()
    assert initial.token not in str(corrupt.value)
    assert str(tmp_path) not in str(corrupt.value)

    _write_private(store.path, "{" + "x" * 5_000 + "}")
    with pytest.raises(InvalidInstallTokenFileError):
        _ = store.read_for_cli()

    store.path.unlink()
    with pytest.raises(InstallTokenNotInitializedError):
        _ = store.read_for_cli()
    with pytest.raises(InstallTokenNotInitializedError):
        _ = store.verify_bearer(initial.token)
    with pytest.raises(InstallTokenNotInitializedError):
        _ = store.rotate()


def test_install_token_rotation_is_atomic_and_generation_comes_from_disk(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = InstallTokenStore(tmp_path / "credentials")
    initial = store.ensure_initial()
    original_replace = os.replace

    def fail_replace(*args: object, **kwargs: object) -> None:
        del args, kwargs
        raise OSError("injected publish failure with a sensitive-looking path")

    monkeypatch.setattr(os, "replace", fail_replace)
    with pytest.raises(InstallTokenStoreError) as failed_rotation:
        _ = store.rotate()
    assert str(tmp_path) not in str(failed_rotation.value)
    monkeypatch.setattr(os, "replace", original_replace)

    assert store.read_for_cli() == initial
    assert not list(store.path.parent.glob(f".{INSTALL_TOKEN_FILENAME}.*.tmp"))

    rotated = store.rotate()
    persisted = store.read_for_cli()
    assert rotated == persisted
    assert rotated.generation == 2
    assert rotated.token != initial.token
    assert initial.token not in repr(rotated)
    with pytest.raises(InstallTokenAuthenticationError):
        _ = store.verify_bearer(initial.token)
    assert store.verify_bearer(rotated.token).generation == 2


def test_bearer_verification_uses_compare_digest_for_success_and_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = InstallTokenStore(tmp_path / "credentials")
    token = store.ensure_initial()
    original_compare = hmac.compare_digest
    calls: list[tuple[bytes, bytes]] = []

    def recording_compare(left: bytes, right: bytes) -> bool:
        calls.append((left, right))
        return original_compare(left, right)

    monkeypatch.setattr(hmac, "compare_digest", recording_compare)

    with pytest.raises(InstallTokenAuthenticationError):
        _ = store.verify_bearer("wrong")
    assert len(calls) == 1
    assert calls[0][0] == token.token.encode("ascii")

    calls.clear()
    assert store.verify_bearer(token.token).generation == token.generation
    assert len(calls) == 1


def test_authorization_header_parser_rejects_malformed_and_oversized_values(
    tmp_path: Path,
) -> None:
    store = InstallTokenStore(tmp_path / "credentials")
    _ = store.ensure_initial()

    malformed_headers = (
        None,
        "",
        "Basic credential",
        "Bearer",
        "Bearer ",
        "Bearer  credential",
        "Bearer credential extra",
        " Bearer credential",
        "Bearer credential ",
        f"Bearer {'x' * 4_097}",
    )
    for header in malformed_headers:
        with pytest.raises(InstallTokenAuthenticationError):
            _ = store.verify_authorization_header(header)


def test_secret_result_dataclasses_hide_plaintext_from_repr() -> None:
    now = datetime.now(UTC)
    bootstrap = BootstrapNonce(
        nonce="bootstrap-secret",
        install_token_generation=1,
        expires_at=now,
    )
    session = BrowserSessionCredentials(
        session_token="session-secret",
        csrf_token="csrf-secret",
        idle_expires_at=now,
        absolute_expires_at=now + timedelta(hours=1),
    )

    assert "bootstrap-secret" not in repr(bootstrap)
    assert "session-secret" not in repr(session)
    assert "csrf-secret" not in repr(session)


@pytest.mark.parametrize(
    "factory",
    [
        lambda: LocalApiSecurityConfig(bootstrap_ttl=timedelta(0)),
        lambda: LocalApiSecurityConfig(bootstrap_ttl=timedelta(minutes=5, microseconds=1)),
        lambda: LocalApiSecurityConfig(idle_ttl=timedelta(0)),
        lambda: LocalApiSecurityConfig(
            idle_ttl=timedelta(hours=9),
            absolute_ttl=timedelta(hours=8),
        ),
        lambda: LocalApiSecurityConfig(absolute_ttl=timedelta(0)),
        lambda: LocalApiSecurityConfig(nonce_retention=timedelta(0)),
        lambda: LocalApiSecurityConfig(session_retention=timedelta(0)),
        lambda: LocalApiSecurityConfig(max_nonce_rows=0),
        lambda: LocalApiSecurityConfig(max_nonce_rows=True),
        lambda: LocalApiSecurityConfig(max_session_rows=0),
        lambda: LocalApiSecurityConfig(max_session_rows=1 << 63),
        lambda: LocalApiSecurityConfig(cleanup_limit=0),
    ],
)
def test_security_config_rejects_non_positive_or_unbounded_values(
    factory: Callable[[], LocalApiSecurityConfig],
) -> None:
    with pytest.raises(LocalApiSecurityConfigurationError):
        _ = factory()


@pytest.mark.parametrize(
    "factory",
    [
        lambda: LocalHttpConfig(canonical_origin="localhost:3000"),
        lambda: LocalHttpConfig(canonical_origin="ftp://localhost:3000"),
        lambda: LocalHttpConfig(canonical_origin="http://localhost:3000/api"),
        lambda: LocalHttpConfig(canonical_origin="http://user:pass@localhost:3000"),
        lambda: LocalHttpConfig(allowed_hosts=frozenset()),
        lambda: LocalHttpConfig(allowed_peers=frozenset()),
        lambda: LocalHttpConfig(max_header_bytes=True),
        lambda: LocalHttpConfig(max_headers=0),
        lambda: LocalHttpConfig(max_request_target_bytes=-1),
        lambda: LocalHttpConfig(max_json_bytes=0),
        lambda: LocalHttpConfig(max_sse_connections_per_session=0),
        lambda: LocalHttpConfig(sse_poll_seconds=0),
        lambda: LocalHttpConfig(sse_heartbeat_seconds=0),
        lambda: LocalHttpConfig(sse_max_seconds=0),
        lambda: LocalHttpConfig(sse_poll_seconds=2.0, sse_heartbeat_seconds=1.0),
    ],
)
def test_local_http_config_rejects_invalid_origins_limits_and_durations(
    factory: Callable[[], LocalHttpConfig],
) -> None:
    with pytest.raises(ValueError):
        _ = factory()


def test_sse_connection_limiter_is_per_session_and_releases_capacity() -> None:
    limiter = SseConnectionLimiter(per_session_limit=2)

    async def exercise() -> None:
        assert await limiter.acquire("session-a")
        assert await limiter.acquire("session-a")
        assert not await limiter.acquire("session-a")
        assert await limiter.acquire("session-b")

        await limiter.release("session-a")
        assert await limiter.acquire("session-a")
        await limiter.release("session-a")
        await limiter.release("session-a")
        assert await limiter.acquire("session-a")

        await limiter.release("session-a")
        await limiter.release("session-b")
        await limiter.release("missing-session")

    asyncio.run(exercise())
