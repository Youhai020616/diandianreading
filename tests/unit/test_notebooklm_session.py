from __future__ import annotations

import asyncio
import json
import os
import stat
import sys
from collections.abc import Mapping
from dataclasses import fields
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

import pytest

import diandianreading.infrastructure.notebooklm.session as session_module
from diandianreading.domain import CredentialRef, DiandianError, ErrorCode, UnsafePathError
from diandianreading.infrastructure.notebooklm import (
    CredentialPathResolver,
    NotebookLMCacheInvalidator,
    NotebookLMSessionManager,
    NotebookLMSessionState,
    NotebookLMSessionStatus,
)

_CHECKED_AT = datetime(2026, 8, 3, 12, 0, tzinfo=UTC)


class FakeRunner:
    def __init__(
        self,
        *,
        return_code: int = 0,
        error: Exception | None = None,
        write_storage: bool = True,
        delay_seconds: float = 0.0,
        events: list[str] | None = None,
        old_marker: Path | None = None,
    ) -> None:
        self.return_code: int = return_code
        self.error: Exception | None = error
        self.write_storage: bool = write_storage
        self.delay_seconds: float = delay_seconds
        self.events: list[str] | None = events
        self.old_marker: Path | None = old_marker
        self.calls: list[tuple[tuple[str, ...], dict[str, str], float]] = []

    async def __call__(
        self,
        argv: tuple[str, ...],
        environment: Mapping[str, str],
        timeout_seconds: float,
    ) -> int:
        self.calls.append((argv, dict(environment), timeout_seconds))
        if self.events is not None:
            self.events.append("runner")
        if self.delay_seconds:
            await asyncio.sleep(self.delay_seconds)
        if self.old_marker is not None:
            assert not self.old_marker.exists()
        if self.error is not None:
            raise self.error
        if self.write_storage:
            storage_path = Path(argv[argv.index("--storage") + 1])
            storage_path.write_text(
                json.dumps({"cookies": [], "origins": []}),
                encoding="utf-8",
            )
            browser_artifact = storage_path.parent / "browser_profile" / "Cookies"
            browser_artifact.write_text("opaque browser state", encoding="utf-8")
            if os.name != "nt":
                storage_path.chmod(0o644)
                browser_artifact.chmod(0o644)
        return self.return_code


class FakeProbe:
    def __init__(self, error: Exception | None = None) -> None:
        self.error: Exception | None = error
        self.calls: list[tuple[Path, str]] = []

    async def __call__(self, storage_path: Path, safe_profile: str) -> None:
        self.calls.append((storage_path, safe_profile))
        if self.error is not None:
            raise self.error
        return None


def write_private(path: Path, content: str) -> Path:
    path.write_text(content, encoding="utf-8")
    if os.name != "nt":
        path.chmod(0o600)
    return path


def write_storage(resolver: CredentialPathResolver, credential: CredentialRef) -> Path:
    paths = resolver.prepare_profile(credential)
    return write_private(paths.storage_state, json.dumps({"cookies": [], "origins": []}))


def make_manager(
    resolver: CredentialPathResolver,
    runner: FakeRunner,
    probe: FakeProbe,
    *,
    cache_invalidator: NotebookLMCacheInvalidator | None = None,
    login_timeout_seconds: float = 300.0,
) -> NotebookLMSessionManager:
    return NotebookLMSessionManager(
        resolver=resolver,
        process_runner=runner,
        passive_probe=probe,
        cache_invalidator=cache_invalidator,
        browser_extra_available=lambda: True,
        login_timeout_seconds=login_timeout_seconds,
        clock=lambda: _CHECKED_AT,
    )


def test_login_uses_safe_argv_sanitized_environment_and_discards_probe_tokens(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("NOTEBOOKLM_AUTH_JSON", "cookie-secret")
    monkeypatch.setenv("NOTEBOOKLM_PROFILE", "attacker-profile")
    monkeypatch.setenv("NOTEBOOKLM_REFRESH_CMD", "leaky refresh command")
    monkeypatch.setenv("NOTEBOOKLM_REFRESH_CMD_USE_SHELL", "1")
    monkeypatch.setenv("_NOTEBOOKLM_REFRESH_ATTEMPTED", "1")
    monkeypatch.setenv("_NOTEBOOKLM_COMPLETE", "source_bash")
    monkeypatch.setenv("PYTHONPATH", "/private/injected-package")
    monkeypatch.setenv("KEEP_ME", "preserved")

    resolver = CredentialPathResolver(tmp_path / "credentials")
    credential = CredentialRef("notebooklm", "alice@example.invalid personal")
    runner = FakeRunner()
    probe = FakeProbe()
    manager = make_manager(
        resolver,
        runner,
        probe,
        login_timeout_seconds=12.5,
    )

    status = asyncio.run(manager.login(credential))

    assert status == NotebookLMSessionStatus(
        provider="notebooklm",
        profile=credential.profile,
        state=NotebookLMSessionState.CONNECTED,
        checked_at=_CHECKED_AT,
    )
    assert [field.name for field in fields(status)] == [
        "provider",
        "profile",
        "state",
        "checked_at",
    ]
    assert len(runner.calls) == 1
    argv, environment, timeout_seconds = runner.calls[0]
    paths = resolver.profile_paths(credential)
    assert argv[:3] == (sys.executable, "-m", "notebooklm")
    assert argv[argv.index("--profile") + 1] == paths.profile_key
    assert argv[argv.index("--storage") + 1] == str(paths.storage_state)
    assert argv[-1] == "login"
    assert "--quiet" in argv
    assert credential.profile not in argv
    assert timeout_seconds == 12.5
    assert environment["NOTEBOOKLM_HOME"] == str(resolver.provider_root)
    assert environment["KEEP_ME"] == "preserved"
    assert "PYTHONPATH" not in environment
    assert all(
        name == "NOTEBOOKLM_HOME"
        for name in environment
        if name.upper().startswith(("NOTEBOOKLM_", "_NOTEBOOKLM_"))
    )
    assert probe.calls == [(paths.storage_state, paths.profile_key)]
    assert "discarded-csrf-token" not in repr(status)
    assert "discarded-session-token" not in repr(status)
    if os.name != "nt":
        assert stat.S_IMODE(paths.storage_state.stat().st_mode) == 0o600
        assert stat.S_IMODE((paths.browser_profile / "Cookies").stat().st_mode) == 0o600


def test_missing_browser_extra_fails_before_runner_or_profile_replacement(tmp_path) -> None:
    resolver = CredentialPathResolver(tmp_path / "credentials")
    credential = CredentialRef("notebooklm", "existing")
    marker = write_private(resolver.prepare_profile(credential).master_token, "keep")
    runner = FakeRunner()
    probe = FakeProbe()
    invalidated: list[CredentialRef] = []

    async def invalidate(candidate: CredentialRef) -> None:
        invalidated.append(candidate)

    manager = NotebookLMSessionManager(
        resolver=resolver,
        process_runner=runner,
        passive_probe=probe,
        cache_invalidator=invalidate,
        browser_extra_available=lambda: False,
    )

    with pytest.raises(DiandianError) as raised:
        asyncio.run(manager.login(credential))

    assert raised.value.code is ErrorCode.VALIDATION
    assert "diandianreading setup notebooklm" in raised.value.public_message
    assert "Reinstall diandianreading" in raised.value.public_message
    assert runner.calls == []
    assert probe.calls == []
    assert invalidated == []
    assert marker.read_text(encoding="utf-8") == "keep"


def test_login_replaces_whole_profile_after_cache_invalidation(tmp_path) -> None:
    resolver = CredentialPathResolver(tmp_path / "credentials")
    credential = CredentialRef("notebooklm", "replace")
    old_paths = resolver.prepare_profile(credential)
    old_marker = write_private(old_paths.master_token, "stale-master-token")
    write_private(old_paths.context, "stale-context")
    events: list[str] = []

    async def invalidate(candidate: CredentialRef) -> None:
        assert candidate == credential
        assert old_marker.exists()
        events.append("invalidate")

    runner = FakeRunner(events=events, old_marker=old_marker)
    probe = FakeProbe()
    manager = make_manager(
        resolver,
        runner,
        probe,
        cache_invalidator=invalidate,
    )

    status = asyncio.run(manager.login(credential))

    assert status.state is NotebookLMSessionState.CONNECTED
    assert events == ["invalidate", "runner"]
    replacement = resolver.profile_paths(credential)
    assert replacement.storage_state.exists()
    assert not replacement.master_token.exists()
    assert not replacement.context.exists()


def test_login_failures_are_sanitized_and_never_emit_vendor_details(tmp_path, capsys) -> None:
    resolver = CredentialPathResolver(tmp_path / "credentials")
    credential = CredentialRef("notebooklm", "safe-status")
    secret_detail = f"{tmp_path}/storage_state.json alice@example.invalid cookie-secret"
    runner = FakeRunner(error=RuntimeError(secret_detail), write_storage=False)
    manager = make_manager(resolver, runner, FakeProbe())

    with pytest.raises(DiandianError) as raised:
        asyncio.run(manager.login(credential))

    assert raised.value.code is ErrorCode.VALIDATION
    assert secret_detail not in raised.value.public_message
    assert str(tmp_path) not in raised.value.public_message
    assert "alice@example.invalid" not in raised.value.public_message
    assert "cookie-secret" not in raised.value.public_message
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""


def test_login_timeout_and_nonzero_exit_map_to_auth_required_without_details(tmp_path) -> None:
    resolver = CredentialPathResolver(tmp_path / "credentials")
    timeout_credential = CredentialRef("notebooklm", "timeout")
    timeout_runner = FakeRunner(
        error=TimeoutError(f"secret path: {tmp_path}"),
        write_storage=False,
    )
    timeout_manager = make_manager(resolver, timeout_runner, FakeProbe())

    with pytest.raises(DiandianError) as timed_out:
        asyncio.run(timeout_manager.login(timeout_credential))
    assert timed_out.value.code is ErrorCode.AUTH_REQUIRED
    assert str(tmp_path) not in timed_out.value.public_message

    bounded_credential = CredentialRef("notebooklm", "bounded")
    bounded_runner = FakeRunner(delay_seconds=0.1, write_storage=False)
    bounded_manager = make_manager(
        resolver,
        bounded_runner,
        FakeProbe(),
        login_timeout_seconds=0.01,
    )
    with pytest.raises(DiandianError) as bounded:
        asyncio.run(bounded_manager.login(bounded_credential))
    assert bounded.value.code is ErrorCode.AUTH_REQUIRED
    assert len(bounded_runner.calls) == 1

    failed_credential = CredentialRef("notebooklm", "failed")
    failed_manager = make_manager(
        resolver,
        FakeRunner(return_code=9, write_storage=False),
        FakeProbe(),
    )
    with pytest.raises(DiandianError) as failed:
        asyncio.run(failed_manager.login(failed_credential))
    assert failed.value.code is ErrorCode.AUTH_REQUIRED


def test_status_maps_missing_connected_expired_and_error_without_details(tmp_path) -> None:
    resolver = CredentialPathResolver(tmp_path / "credentials")
    credential = CredentialRef("notebooklm", "logical-profile")
    runner = FakeRunner(write_storage=False)
    probe = FakeProbe()
    manager = make_manager(resolver, runner, probe)

    missing = asyncio.run(manager.status(credential))
    assert missing.state is NotebookLMSessionState.MISSING
    assert probe.calls == []
    assert not resolver.provider_root.exists()

    storage_path = write_storage(resolver, credential)
    paths = resolver.profile_paths(credential)
    connected = asyncio.run(manager.status(credential))
    assert connected.state is NotebookLMSessionState.CONNECTED
    assert connected.profile == credential.profile
    assert connected.checked_at == _CHECKED_AT
    assert probe.calls[-1] == (storage_path, paths.profile_key)

    probe.error = ValueError(f"expired cookie at {storage_path}")
    expired = asyncio.run(manager.status(credential))
    assert expired.state is NotebookLMSessionState.EXPIRED
    assert str(storage_path) not in repr(expired)

    probe.error = RuntimeError(f"network failure for alice@example.invalid at {storage_path}")
    errored = asyncio.run(manager.status(credential))
    assert errored.state is NotebookLMSessionState.ERROR
    assert str(storage_path) not in repr(errored)
    assert "alice@example.invalid" not in repr(errored)

    probe.error = None
    write_private(storage_path, "not-json")
    calls_before_invalid_storage = len(probe.calls)
    invalid_storage = asyncio.run(manager.status(credential))
    assert invalid_storage.state is NotebookLMSessionState.EXPIRED
    assert len(probe.calls) == calls_before_invalid_storage


def test_status_maps_unsafe_profile_tree_to_error_without_running_probe(tmp_path) -> None:
    if not hasattr(os, "symlink"):
        pytest.skip("symlinks unavailable")
    resolver = CredentialPathResolver(tmp_path / "credentials")
    credential = CredentialRef("notebooklm", "unsafe")
    write_storage(resolver, credential)
    paths = resolver.profile_paths(credential)
    outside = write_private(tmp_path / "outside", "keep")
    (paths.browser_profile / "escape").symlink_to(outside)
    probe = FakeProbe()
    manager = make_manager(resolver, FakeRunner(write_storage=False), probe)

    status = asyncio.run(manager.status(credential))

    assert status.state is NotebookLMSessionState.ERROR
    assert probe.calls == []
    assert outside.read_text(encoding="utf-8") == "keep"


def test_logout_deletes_only_local_complete_profile_after_cache_invalidation(tmp_path) -> None:
    resolver = CredentialPathResolver(tmp_path / "credentials")
    credential = CredentialRef("notebooklm", "logout")
    sibling = CredentialRef("notebooklm", "sibling")
    paths = resolver.prepare_profile(credential)
    sibling_paths = resolver.prepare_profile(sibling)
    for artifact in (
        paths.storage_state,
        paths.context,
        paths.storage_context,
        paths.master_token,
        paths.browser_profile / "Cookies",
    ):
        write_private(artifact, "remove")
    sibling_marker = write_private(sibling_paths.browser_profile / "marker", "keep")
    provider_marker = write_private(resolver.provider_root / "sentinel", "keep")
    events: list[str] = []

    async def invalidate(candidate: CredentialRef) -> None:
        assert candidate == credential
        assert paths.profile_directory.exists()
        events.append("invalidate")

    manager = make_manager(
        resolver,
        FakeRunner(write_storage=False),
        FakeProbe(),
        cache_invalidator=invalidate,
    )

    deleted = asyncio.run(manager.logout(credential))

    assert deleted is True
    assert events == ["invalidate"]
    assert not paths.profile_directory.exists()
    assert sibling_marker.read_text(encoding="utf-8") == "keep"
    assert provider_marker.read_text(encoding="utf-8") == "keep"
    assert asyncio.run(manager.logout(credential)) is False
    assert events == ["invalidate"]


def test_logout_rejects_symlinks_and_does_not_delete_external_target(tmp_path) -> None:
    if not hasattr(os, "symlink"):
        pytest.skip("symlinks unavailable")
    resolver = CredentialPathResolver(tmp_path / "credentials")
    credential = CredentialRef("notebooklm", "unsafe-logout")
    paths = resolver.prepare_profile(credential)
    outside = write_private(tmp_path / "outside", "keep")
    (paths.browser_profile / "escape").symlink_to(outside)
    manager = make_manager(resolver, FakeRunner(write_storage=False), FakeProbe())

    with pytest.raises(UnsafePathError, match="symbolic links"):
        asyncio.run(manager.logout(credential))

    assert paths.profile_directory.exists()
    assert outside.read_text(encoding="utf-8") == "keep"


def test_require_authenticated_and_constructor_validation_are_typed(tmp_path) -> None:
    resolver = CredentialPathResolver(tmp_path / "credentials")
    credential = CredentialRef("notebooklm", "required")
    manager = make_manager(resolver, FakeRunner(write_storage=False), FakeProbe())

    with pytest.raises(DiandianError) as missing:
        asyncio.run(manager.require_authenticated(credential))
    assert missing.value.code is ErrorCode.AUTH_REQUIRED

    with pytest.raises(ValueError, match="requires a NotebookLM"):
        asyncio.run(manager.status(CredentialRef("other", "required")))

    for invalid_timeout in (0.0, -1.0, float("inf"), float("nan")):
        with pytest.raises(ValueError, match="finite and positive"):
            NotebookLMSessionManager(
                resolver=resolver,
                process_runner=FakeRunner(),
                passive_probe=FakeProbe(),
                browser_extra_available=lambda: True,
                login_timeout_seconds=invalid_timeout,
            )


def test_default_process_runner_uses_argv_environment_and_devnull_only(monkeypatch) -> None:
    class Process:
        def __init__(self) -> None:
            self.returncode = None
            self.wait_calls = 0

        async def wait(self) -> int:
            self.wait_calls += 1
            self.returncode = 7
            return 7

    process = Process()
    captured: dict[str, object] = {}

    async def create_subprocess_exec(*argv, **kwargs):
        captured["argv"] = argv
        captured["kwargs"] = kwargs
        return process

    monkeypatch.setattr(session_module.asyncio, "create_subprocess_exec", create_subprocess_exec)
    environment = {"SAFE": "value"}
    argv = (sys.executable, "-m", "notebooklm", "login")

    return_code = asyncio.run(
        session_module._run_notebooklm_process(argv, environment, timeout_seconds=1.0)
    )

    assert return_code == 7
    assert process.wait_calls == 1
    assert captured["argv"] == argv
    kwargs = captured["kwargs"]
    assert isinstance(kwargs, dict)
    assert kwargs["env"] == environment
    assert kwargs["env"] is not environment
    assert kwargs["stdin"] == asyncio.subprocess.DEVNULL
    assert kwargs["stdout"] == asyncio.subprocess.DEVNULL
    assert kwargs["stderr"] == asyncio.subprocess.DEVNULL


@pytest.mark.parametrize("error_type", (TimeoutError, asyncio.CancelledError))
def test_default_process_runner_terminates_on_timeout_or_cancellation(
    error_type,
    monkeypatch,
) -> None:
    class Process:
        returncode = None

        async def wait(self) -> int:
            raise error_type("controlled process interruption")

    process = Process()
    terminated: list[object] = []

    async def create_subprocess_exec(*argv, **kwargs):
        del argv, kwargs
        return process

    async def terminate(candidate) -> None:
        terminated.append(candidate)

    monkeypatch.setattr(session_module.asyncio, "create_subprocess_exec", create_subprocess_exec)
    monkeypatch.setattr(session_module, "_terminate_process", terminate)

    with pytest.raises(error_type):
        asyncio.run(
            session_module._run_notebooklm_process(
                (sys.executable, "-m", "notebooklm", "login"),
                {},
                timeout_seconds=1.0,
            )
        )

    assert terminated == [process]


def test_process_termination_escalates_and_handles_process_lookup_races() -> None:
    class EscalatingProcess:
        def __init__(self) -> None:
            self.returncode = None
            self.wait_calls = 0
            self.terminate_calls = 0
            self.kill_calls = 0

        def terminate(self) -> None:
            self.terminate_calls += 1

        def kill(self) -> None:
            self.kill_calls += 1

        async def wait(self) -> int:
            self.wait_calls += 1
            if self.wait_calls == 1:
                raise TimeoutError("controlled termination timeout")
            self.returncode = -9
            return -9

    escalating = EscalatingProcess()
    asyncio.run(
        session_module._terminate_process(
            cast(asyncio.subprocess.Process, cast(object, escalating))
        )
    )
    assert escalating.terminate_calls == 1
    assert escalating.kill_calls == 1
    assert escalating.wait_calls == 2

    class CompletedProcess:
        returncode = 0

        def terminate(self) -> None:
            raise AssertionError("completed process was terminated")

        async def wait(self) -> int:
            raise AssertionError("completed process was awaited")

    asyncio.run(
        session_module._terminate_process(
            cast(asyncio.subprocess.Process, cast(object, CompletedProcess()))
        )
    )

    class RacedProcess:
        returncode = None

        def __init__(self) -> None:
            self.wait_calls = 0

        def terminate(self) -> None:
            raise ProcessLookupError

        async def wait(self) -> int:
            self.wait_calls += 1
            return 0

    raced = RacedProcess()
    asyncio.run(
        session_module._terminate_process(cast(asyncio.subprocess.Process, cast(object, raced)))
    )
    assert raced.wait_calls == 0


@pytest.mark.parametrize(
    ("probe_error", "expected_state"),
    (
        (FileNotFoundError("secret storage path"), NotebookLMSessionState.EXPIRED),
        (
            DiandianError(ErrorCode.AUTH_REQUIRED, "secret expired cookie", retryable=False),
            NotebookLMSessionState.EXPIRED,
        ),
        (
            DiandianError(
                ErrorCode.SOURCE_UNAVAILABLE,
                "secret provider failure",
                retryable=True,
            ),
            NotebookLMSessionState.ERROR,
        ),
    ),
)
def test_status_maps_file_and_typed_probe_errors_without_leaking_details(
    probe_error,
    expected_state,
    tmp_path,
) -> None:
    resolver = CredentialPathResolver(tmp_path / "credentials")
    credential = CredentialRef("notebooklm", "typed-probe")
    write_storage(resolver, credential)
    probe = FakeProbe(probe_error)
    manager = make_manager(resolver, FakeRunner(write_storage=False), probe)

    status = asyncio.run(manager.status(credential))

    assert status.state is expected_state
    assert len(probe.calls) == 1
    assert "secret" not in repr(status)


def test_require_authenticated_maps_probe_error_to_retryable_source_error(tmp_path) -> None:
    resolver = CredentialPathResolver(tmp_path / "credentials")
    credential = CredentialRef("notebooklm", "provider-error")
    write_storage(resolver, credential)
    manager = make_manager(
        resolver,
        FakeRunner(write_storage=False),
        FakeProbe(RuntimeError("secret provider failure")),
    )

    with pytest.raises(DiandianError) as raised:
        asyncio.run(manager.require_authenticated(credential))

    assert raised.value.code is ErrorCode.SOURCE_UNAVAILABLE
    assert raised.value.retryable is True
    assert "secret" not in raised.value.public_message


@pytest.mark.parametrize(
    ("probe_error", "expected_code"),
    (
        (ValueError("secret invalid cookies"), ErrorCode.AUTH_REQUIRED),
        (RuntimeError("secret provider failure"), ErrorCode.SOURCE_UNAVAILABLE),
    ),
)
def test_login_maps_post_process_probe_failures_to_safe_typed_errors(
    probe_error,
    expected_code,
    tmp_path,
) -> None:
    resolver = CredentialPathResolver(tmp_path / "credentials")
    credential = CredentialRef("notebooklm", f"verify-{expected_code.value.casefold()}")
    manager = make_manager(resolver, FakeRunner(), FakeProbe(probe_error))

    with pytest.raises(DiandianError) as raised:
        asyncio.run(manager.login(credential))

    assert raised.value.code is expected_code
    assert "secret" not in raised.value.public_message


def test_status_and_login_sanitize_profile_access_filesystem_errors(
    tmp_path,
    monkeypatch,
) -> None:
    resolver = CredentialPathResolver(tmp_path / "credentials")
    credential = CredentialRef("notebooklm", "filesystem-access")
    runner = FakeRunner(write_storage=False)
    probe = FakeProbe()
    manager = make_manager(resolver, runner, probe)

    def fail_profile_access(candidate: CredentialRef) -> bool:
        assert candidate == credential
        raise OSError(f"secret profile path under {tmp_path}")

    monkeypatch.setattr(resolver, "profile_exists", fail_profile_access)

    status = asyncio.run(manager.status(credential))
    assert status.state is NotebookLMSessionState.ERROR
    assert probe.calls == []

    with pytest.raises(DiandianError) as raised:
        asyncio.run(manager.login(credential))
    assert raised.value.code is ErrorCode.VALIDATION
    assert str(tmp_path) not in raised.value.public_message
    assert runner.calls == []


def test_login_sanitizes_prepare_and_secure_filesystem_errors(tmp_path, monkeypatch) -> None:
    resolver = CredentialPathResolver(tmp_path / "credentials")

    prepare_credential = CredentialRef("notebooklm", "prepare-error")
    prepare_runner = FakeRunner(write_storage=False)

    def fail_prepare(candidate: CredentialRef):
        assert candidate == prepare_credential
        raise OSError(f"secret prepare path under {tmp_path}")

    with monkeypatch.context() as patch:
        patch.setattr(resolver, "profile_exists", lambda candidate: False)
        patch.setattr(resolver, "prepare_profile", fail_prepare)
        manager = make_manager(resolver, prepare_runner, FakeProbe())
        with pytest.raises(DiandianError) as prepared:
            asyncio.run(manager.login(prepare_credential))
    assert prepared.value.code is ErrorCode.VALIDATION
    assert str(tmp_path) not in prepared.value.public_message
    assert prepare_runner.calls == []

    secure_credential = CredentialRef("notebooklm", "secure-error")
    secure_runner = FakeRunner(write_storage=False)

    def fail_secure(paths) -> None:
        assert paths == resolver.profile_paths(secure_credential)
        raise OSError(f"secret secure path under {tmp_path}")

    with monkeypatch.context() as patch:
        patch.setattr(resolver, "secure_profile_tree", fail_secure)
        manager = make_manager(resolver, secure_runner, FakeProbe())
        with pytest.raises(DiandianError) as secured:
            asyncio.run(manager.login(secure_credential))
    assert secured.value.code is ErrorCode.VALIDATION
    assert str(tmp_path) not in secured.value.public_message
    assert len(secure_runner.calls) == 1


def test_logout_sanitizes_delete_filesystem_errors(tmp_path, monkeypatch) -> None:
    resolver = CredentialPathResolver(tmp_path / "credentials")
    credential = CredentialRef("notebooklm", "delete-error")
    resolver.prepare_profile(credential)
    manager = make_manager(resolver, FakeRunner(write_storage=False), FakeProbe())

    def fail_delete(candidate: CredentialRef) -> bool:
        assert candidate == credential
        raise OSError(f"secret delete path under {tmp_path}")

    monkeypatch.setattr(resolver, "delete_profile", fail_delete)

    with pytest.raises(DiandianError) as raised:
        asyncio.run(manager.logout(credential))

    assert raised.value.code is ErrorCode.VALIDATION
    assert str(tmp_path) not in raised.value.public_message
