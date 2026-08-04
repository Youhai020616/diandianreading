from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest

import diandianreading.interfaces.cli as cli_module
from diandianreading.domain import CredentialRef, DiandianError, ErrorCode, JobStatus, RightsBasis
from diandianreading.infrastructure.persistence import SQLiteDatabase
from diandianreading.interfaces.cli import build_parser, main
from tests.support import FIXED_NOW


class FakeProductRuntime:
    def __init__(self, **services: object) -> None:
        self.close_count = 0
        self.config: Any = None
        self.zlibrary_enabled = False
        for name, service in services.items():
            setattr(self, name, service)

    async def aclose(self) -> None:
        self.close_count += 1


def install_runtime(
    monkeypatch: pytest.MonkeyPatch,
    runtime: FakeProductRuntime,
) -> list[tuple[object, Any]]:
    calls: list[tuple[object, Any]] = []

    def create(paths: object, *, config: Any):
        calls.append((paths, config))
        runtime.config = config
        runtime.zlibrary_enabled = config.zlibrary_enabled
        return runtime

    monkeypatch.setattr(cli_module, "create_runtime", create)
    return calls


def queued_job_view(job_id: str = "job-1") -> SimpleNamespace:
    return SimpleNamespace(
        id=job_id,
        job_type="import_book",
        book_title="Safe title",
        status=JobStatus.QUEUED,
        current_step=None,
        attempt=1,
        progress_current=None,
        progress_total=None,
        last_error_code=None,
        retriable=None,
        blocked_reason=None,
        book_id=None,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
        completed_at=None,
    )


class RecordingImportSubmission:
    def __init__(self) -> None:
        self.local_calls: list[tuple[object, dict[str, object]]] = []
        self.zlibrary_calls: list[tuple[str, dict[str, object]]] = []

    async def submit_local(self, source, **kwargs):
        self.local_calls.append((source, kwargs))
        return SimpleNamespace(id="job-1")

    def submit_zlibrary(self, locator: str, **kwargs):
        self.zlibrary_calls.append((locator, kwargs))
        return SimpleNamespace(id="job-1")


def test_cli_requires_a_subcommand() -> None:
    with pytest.raises(SystemExit) as raised:
        build_parser().parse_args([])
    assert raised.value.code == 2


def test_cli_runs_phase0_demo_and_returns_structured_collision_error(tmp_path, capsys) -> None:
    database = tmp_path / "state" / "app.sqlite3"
    workspace = tmp_path / "state" / "workspace"
    argv = [
        "phase0-e2e",
        "--database",
        str(database),
        "--workspace",
        str(workspace),
    ]
    assert main(argv) == 0
    first_capture = capsys.readouterr()
    payload = json.loads(first_capture.out)
    assert payload["status"] == "ok"
    assert payload["progress_event_count"] > 0
    assert payload["preparation_manifest_key"].startswith("manifests/")
    assert payload["remote_operation_count"] == 3
    sentinel = workspace / "phase0-sample.md"
    original = sentinel.read_text(encoding="utf-8")

    assert main(argv) == 2
    second_capture = capsys.readouterr()
    error = json.loads(second_capture.err)
    assert error == {
        "error": {
            "code": "VALIDATION",
            "message": f"Refusing to overwrite existing workspace: {workspace}",
            "retryable": False,
        },
        "status": "error",
    }
    assert second_capture.out == ""
    assert sentinel.read_text(encoding="utf-8") == original


def test_cli_runs_phase1_real_document_preparation_demo(tmp_path, capsys) -> None:
    database = tmp_path / "state" / "app.sqlite3"
    object_root = tmp_path / "objects"
    workspace = tmp_path / "workspace"

    exit_code = main(
        [
            "phase1-e2e",
            "--database",
            str(database),
            "--object-root",
            str(object_root),
            "--workspace",
            str(workspace),
        ]
    )

    assert exit_code == 0
    captured = capsys.readouterr()
    assert captured.err == ""
    payload = json.loads(captured.out)
    assert payload["status"] == "ok"
    assert payload["format_count"] == 3
    assert payload["manifest_count"] == 3
    assert payload["source_count"] == payload["part_count"]
    assert payload["remote_operation_count"] == payload["source_count"] + 3


def test_cli_runs_phase2_notebooklm_adapter_demo(tmp_path, capsys) -> None:
    database = tmp_path / "state" / "app.sqlite3"
    object_root = tmp_path / "objects"
    credentials_root = tmp_path / "credentials"
    workspace = tmp_path / "workspace"

    exit_code = main(
        [
            "phase2-e2e",
            "--database",
            str(database),
            "--object-root",
            str(object_root),
            "--credentials-root",
            str(credentials_root),
            "--workspace",
            str(workspace),
        ]
    )

    assert exit_code == 0
    captured = capsys.readouterr()
    assert captured.err == ""
    payload = json.loads(captured.out)
    assert payload["status"] == "ok"
    assert payload["schema_version"] == 9
    assert payload["citation_count"] == payload["source_count"]
    assert payload["provider_write_intent_count"] == payload["remote_operation_count"]
    assert str(credentials_root) not in captured.out


def test_cli_runs_phase3_recoverable_workflow_demo(tmp_path, capsys) -> None:
    database = tmp_path / "state" / "app.sqlite3"
    workspace = tmp_path / "workspace"

    exit_code = main(
        [
            "phase3-e2e",
            "--database",
            str(database),
            "--workspace",
            str(workspace),
        ]
    )

    assert exit_code == 0
    captured = capsys.readouterr()
    assert captured.err == ""
    payload = json.loads(captured.out)
    assert payload["status"] == "ok"
    assert payload["schema_version"] == 9
    assert payload["crash_boundary_count"] == 11
    assert payload["completed_job_count"] == 13
    assert payload["cancelled_job_count"] == 1
    assert payload["unresolved_operation_count"] == 0
    assert payload["provider_workspace_write_count"] == 13
    assert payload["provider_source_write_count"] == 35


def test_cli_runs_phase4_governed_zlibrary_adapter_demo(tmp_path, capsys) -> None:
    database = tmp_path / "state" / "app.sqlite3"
    object_root = tmp_path / "objects"
    credentials_root = tmp_path / "credentials"
    workspace = tmp_path / "workspace"

    exit_code = main(
        [
            "phase4-e2e",
            "--database",
            str(database),
            "--object-root",
            str(object_root),
            "--credentials-root",
            str(credentials_root),
            "--workspace",
            str(workspace),
        ]
    )

    assert exit_code == 0
    captured = capsys.readouterr()
    assert captured.err == ""
    payload = json.loads(captured.out)
    assert payload["status"] == "ok"
    assert payload["schema_version"] == 9
    assert payload["default_disabled_gate_verified"] is True
    assert payload["bound_content_hash_count"] == 2
    assert payload["expect_download_count"] == 2
    assert payload["legacy_config_read_count"] == 0
    assert payload["provider_isolation_verified"] is True
    assert str(credentials_root) not in captured.out


def test_cli_expands_tilde_before_existing_database_check(tmp_path, monkeypatch, capsys) -> None:
    home = tmp_path / "home"
    state = home / ".state"
    state.mkdir(parents=True, mode=0o700)
    state.chmod(0o700)
    database = SQLiteDatabase.create_new(state / "app.sqlite3")
    monkeypatch.setenv("HOME", str(home))

    exit_code = main(
        [
            "phase0-e2e",
            "--database",
            "~/.state/app.sqlite3",
            "--workspace",
            "~/.state/workspace",
        ]
    )

    assert exit_code == 2
    error = json.loads(capsys.readouterr().err)
    assert error["error"]["code"] == "VALIDATION"
    assert str(database.path) in error["error"]["message"]


def test_cli_runs_phase5_secured_unified_product_demo(tmp_path, capsys) -> None:
    app_home = tmp_path / "phase5-home"
    workspace = tmp_path / "phase5-workspace"

    assert (
        main(
            [
                "phase5-e2e",
                "--app-home",
                str(app_home),
                "--workspace",
                str(workspace),
            ]
        )
        == 0
    )

    captured = capsys.readouterr()
    assert captured.err == ""
    payload = json.loads(captured.out)
    assert payload == {
        "book_count": 1,
        "chat_sse_verified": True,
        "chat_status": "completed",
        "citation_count": 1,
        "cross_origin_rejected": True,
        "job_sse_verified": True,
        "job_status": "completed",
        "provider_status_verified": True,
        "schema_version": 9,
        "session_bootstrap_verified": True,
        "status": "ok",
    }

    assert (
        main(
            [
                "phase5-e2e",
                "--app-home",
                str(app_home),
                "--workspace",
                str(workspace),
            ]
        )
        == 2
    )
    error = json.loads(capsys.readouterr().err)
    assert error["error"]["code"] == "VALIDATION"


def test_unified_cli_auth_import_and_job_listing_are_path_safe(tmp_path, capsys) -> None:
    home = tmp_path / "app-home"
    source = tmp_path / "owned.md"
    source.write_text("# Owned book\n\nLocal bytes.\n", encoding="utf-8")

    assert main(["--home", str(home), "auth", "status"]) == 0
    status_capture = capsys.readouterr()
    statuses = json.loads(status_capture.out)
    assert statuses["providers"]["notebooklm"]["state"] == "missing"
    assert statuses["providers"]["zlibrary"]["state"] == "missing"
    assert str(home) not in status_capture.out

    assert (
        main(
            [
                "--home",
                str(home),
                "import",
                str(source),
                "--rights-basis",
                "owned_copy",
                "--rights-confirmed",
            ]
        )
        == 0
    )
    import_capture = capsys.readouterr()
    imported = json.loads(import_capture.out)
    assert imported["job"]["status"] == "queued"
    assert str(source) not in import_capture.out

    assert main(["--home", str(home), "jobs", "list", "--limit", "10"]) == 0
    listed = json.loads(capsys.readouterr().out)
    assert [job["id"] for job in listed["jobs"]] == [imported["job"]["id"]]

    assert (
        main(
            [
                "--home",
                str(home),
                "import",
                str(source),
                "--rights-basis",
                "owned_copy",
            ]
        )
        == 2
    )
    validation = json.loads(capsys.readouterr().err)
    assert validation["error"]["code"] == "VALIDATION"


def test_unified_cli_logout_missing_profiles_is_idempotent(tmp_path, capsys) -> None:
    home = tmp_path / "app-home"
    assert main(["--home", str(home), "auth", "logout", "notebooklm", "--profile", "default"]) == 0
    notebook = json.loads(capsys.readouterr().out)
    assert notebook["local_profile_removed"] is False

    assert main(["--home", str(home), "auth", "logout", "zlibrary", "--profile", "default"]) == 0
    zlibrary = json.loads(capsys.readouterr().out)
    assert zlibrary["local_profile_removed"] is False


@pytest.mark.parametrize(
    ("provider", "async_logout"),
    (("notebooklm", True), ("zlibrary", False)),
)
def test_unified_cli_auth_login_and_logout_use_managed_profiles(
    provider,
    async_logout,
    tmp_path,
    monkeypatch,
    capsys,
) -> None:
    class RecordingSession:
        def __init__(self, session_provider: str, *, logout_is_async: bool) -> None:
            self.provider = session_provider
            self.logout_is_async = logout_is_async
            self.login_calls: list[CredentialRef] = []
            self.logout_calls: list[CredentialRef] = []

        async def login(self, credential: CredentialRef):
            self.login_calls.append(credential)
            return SimpleNamespace(
                provider=credential.provider,
                profile=credential.profile,
                state="connected",
                checked_at=FIXED_NOW,
            )

        def logout(self, credential: CredentialRef):
            self.logout_calls.append(credential)
            if not self.logout_is_async:
                return True

            async def remove_profile() -> bool:
                return True

            return remove_profile()

    notebooklm = RecordingSession("notebooklm", logout_is_async=provider == "notebooklm")
    zlibrary = RecordingSession("zlibrary", logout_is_async=provider == "zlibrary")
    runtime = FakeProductRuntime(
        notebooklm_session=notebooklm,
        zlibrary_session=zlibrary,
    )
    install_runtime(monkeypatch, runtime)
    profile = "reader-profile"
    selected = notebooklm if provider == "notebooklm" else zlibrary

    assert (
        main(
            [
                "--home",
                str(tmp_path / "home"),
                "auth",
                "login",
                provider,
                "--profile",
                profile,
            ]
        )
        == 0
    )
    login_result = json.loads(capsys.readouterr().out)
    assert login_result["provider"]["state"] == "connected"
    assert selected.login_calls == [CredentialRef(provider, profile)]

    selected.logout_is_async = async_logout
    assert (
        main(
            [
                "--home",
                str(tmp_path / "home"),
                "auth",
                "logout",
                provider,
                "--profile",
                profile,
            ]
        )
        == 0
    )
    logout_result = json.loads(capsys.readouterr().out)
    assert logout_result["local_profile_removed"] is True
    assert selected.logout_calls == [CredentialRef(provider, profile)]
    assert runtime.close_count == 2


@pytest.mark.parametrize(
    ("rights_basis", "license_identifier"),
    (("public_domain", "public-domain-us"), ("open_license", "CC-BY-4.0")),
)
def test_unified_cli_requires_and_forwards_license_identifiers(
    rights_basis,
    license_identifier,
    tmp_path,
    monkeypatch,
    capsys,
) -> None:
    submission = RecordingImportSubmission()
    runtime = FakeProductRuntime(
        import_submission=submission,
        jobs=SimpleNamespace(get=lambda job_id: queued_job_view(job_id)),
        target_capabilities=object(),
    )
    install_runtime(monkeypatch, runtime)
    base = [
        "--home",
        str(tmp_path / "home"),
        "import",
        "logical-book.md",
        "--rights-basis",
        rights_basis,
        "--rights-confirmed",
    ]

    assert main(base) == 2
    missing = json.loads(capsys.readouterr().err)
    assert missing["error"] == {
        "code": "VALIDATION",
        "message": "Public-domain and open-license imports require --license-identifier",
        "retryable": False,
    }
    assert submission.local_calls == []

    assert main([*base, "--license-identifier", license_identifier]) == 0
    accepted = json.loads(capsys.readouterr().out)
    assert accepted["job"]["status"] == "queued"
    assert len(submission.local_calls) == 1
    _, kwargs = submission.local_calls[0]
    assert kwargs["rights_basis"] is RightsBasis(rights_basis)
    assert kwargs["license_identifier"] == license_identifier
    assert runtime.close_count == 2


def test_unified_cli_enforces_zlibrary_gate_title_and_explicit_enablement(
    tmp_path,
    monkeypatch,
    capsys,
) -> None:
    monkeypatch.delenv("DIANDIAN_ZLIBRARY_ENABLED", raising=False)
    submission = RecordingImportSubmission()
    runtime = FakeProductRuntime(
        import_submission=submission,
        jobs=SimpleNamespace(get=lambda job_id: queued_job_view(job_id)),
        target_capabilities=object(),
    )
    runtime_calls = install_runtime(monkeypatch, runtime)
    base = [
        "--home",
        str(tmp_path / "home"),
        "import",
        "book-locator",
        "--provider",
        "zlibrary",
        "--rights-basis",
        "owned_copy",
        "--rights-confirmed",
    ]

    assert main(base) == 2
    disabled = json.loads(capsys.readouterr().err)
    assert "Z-Library is disabled" in disabled["error"]["message"]
    assert submission.zlibrary_calls == []

    assert main([*base, "--enable-zlibrary"]) == 2
    missing_title = json.loads(capsys.readouterr().err)
    assert missing_title["error"]["message"] == "Z-Library imports require --title"
    assert submission.zlibrary_calls == []

    assert main([*base, "--enable-zlibrary", "--title", "Licensed book"]) == 0
    accepted = json.loads(capsys.readouterr().out)
    assert accepted["job"]["status"] == "queued"
    assert submission.zlibrary_calls[0][0] == "book-locator"
    assert submission.zlibrary_calls[0][1]["rights_basis"] is RightsBasis.OWNED_COPY
    assert [config.zlibrary_enabled for _, config in runtime_calls] == [False, True, True]
    assert runtime.close_count == 3


def test_unified_cli_rejects_invalid_job_filters_and_surfaces_retry_errors(
    tmp_path,
    monkeypatch,
    capsys,
) -> None:
    class FailingJobs:
        def __init__(self) -> None:
            self.retry_calls: list[str] = []

        def list(self, query):
            raise AssertionError(f"invalid query reached repository: {query!r}")

        def retry(self, job_id: str):
            self.retry_calls.append(job_id)
            raise DiandianError(ErrorCode.VALIDATION, "Job was not found", retryable=False)

    jobs = FailingJobs()
    runtime = FakeProductRuntime(jobs=jobs)
    install_runtime(monkeypatch, runtime)
    home = str(tmp_path / "home")

    assert main(["--home", home, "jobs", "list", "--limit", "0"]) == 2
    invalid_filter = json.loads(capsys.readouterr().err)
    assert invalid_filter["error"]["message"] == "Job page limit must be between 1 and 100"

    assert main(["--home", home, "jobs", "retry", "missing-job"]) == 3
    invalid_retry = json.loads(capsys.readouterr().err)
    assert invalid_retry["error"] == {
        "code": "VALIDATION",
        "message": "Job was not found",
        "retryable": False,
    }
    assert jobs.retry_calls == ["missing-job"]
    assert runtime.close_count == 2


def test_unified_cli_parser_rejects_unknown_job_status() -> None:
    with pytest.raises(SystemExit) as raised:
        build_parser().parse_args(["jobs", "list", "--status", "not-a-status"])
    assert raised.value.code == 2


def test_unified_cli_worker_once_is_portless_and_closes_runtime(
    tmp_path,
    monkeypatch,
    capsys,
) -> None:
    class RecordingWorker:
        def __init__(self) -> None:
            self.calls = 0

        async def run_once(self) -> bool:
            self.calls += 1
            return True

    worker = RecordingWorker()
    runtime = FakeProductRuntime(worker=worker)
    runtime_calls = install_runtime(monkeypatch, runtime)

    assert (
        main(
            [
                "--home",
                str(tmp_path / "home"),
                "worker",
                "--once",
                "--enable-zlibrary",
            ]
        )
        == 0
    )

    assert json.loads(capsys.readouterr().out) == {"handled": True, "status": "ok"}
    assert worker.calls == 1
    assert runtime.close_count == 1
    assert runtime_calls[0][1].zlibrary_enabled is True


def test_unified_cli_serve_uses_mocked_server_and_schedules_mocked_browser(
    tmp_path,
    monkeypatch,
    capsys,
) -> None:
    class Security:
        def __init__(self) -> None:
            self.calls = 0

        def issue_bootstrap(self):
            self.calls += 1
            return SimpleNamespace(nonce="nonce with /?")

    timers: list[Any] = []
    configs: list[Any] = []
    servers: list[Any] = []

    class FakeTimer:
        def __init__(self, interval, function, args=()) -> None:
            self.interval = interval
            self.function = function
            self.args = args
            self.daemon = False
            self.started = False
            timers.append(self)

        def start(self) -> None:
            self.started = True

    class FakeConfig:
        def __init__(self, app, **kwargs) -> None:
            self.app = app
            self.kwargs = kwargs
            configs.append(self)

    class FakeServer:
        def __init__(self, config) -> None:
            self.config = config
            self.ran = False
            servers.append(self)

        def run(self) -> None:
            self.ran = True

    security = Security()
    runtime = FakeProductRuntime(security=security)
    runtime_calls = install_runtime(monkeypatch, runtime)
    app = object()
    port_checks: list[int] = []
    monkeypatch.setattr(
        cli_module,
        "_require_port_3000_available",
        lambda: port_checks.append(3000),
    )
    monkeypatch.setattr(cli_module, "create_web_app", lambda candidate: app)
    monkeypatch.setattr(cli_module.threading, "Timer", FakeTimer)
    monkeypatch.setattr(cli_module.uvicorn, "Config", FakeConfig)
    monkeypatch.setattr(cli_module.uvicorn, "Server", FakeServer)

    assert (
        main(
            [
                "--home",
                str(tmp_path / "home"),
                "serve",
                "--enable-zlibrary",
            ]
        )
        == 0
    )

    assert json.loads(capsys.readouterr().out) == {
        "origin": "http://localhost:3000",
        "status": "starting",
        "worker": "enabled",
        "zlibrary": "enabled",
    }
    assert port_checks == [3000]
    assert security.calls == 1
    assert runtime_calls[0][1].zlibrary_enabled is True
    timer = timers[0]
    assert timer.interval == 0.8
    assert timer.args == ("http://localhost:3000/#bootstrap=nonce%20with%20%2F%3F",)
    assert timer.daemon is True
    assert timer.started is True
    assert configs[0].app is app
    assert configs[0].kwargs["host"] == "127.0.0.1"
    assert configs[0].kwargs["port"] == 3000
    assert servers[0].config is configs[0]
    assert servers[0].ran is True
    assert runtime.close_count == 0


def test_unified_cli_port_conflict_is_structured_before_runtime_creation(
    monkeypatch,
    capsys,
) -> None:
    class OccupiedSocket:
        def __init__(self) -> None:
            self.options: list[tuple[int, int, int]] = []
            self.bind_calls: list[tuple[str, int]] = []

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc_value, traceback) -> None:
            del exc_type, exc_value, traceback

        def setsockopt(self, level: int, option: int, value: int) -> None:
            self.options.append((level, option, value))

        def bind(self, address: tuple[str, int]) -> None:
            self.bind_calls.append(address)
            raise OSError("secret process already owns the port")

    occupied = OccupiedSocket()
    monkeypatch.setattr(cli_module.socket, "socket", lambda *args, **kwargs: occupied)

    def unexpected_runtime(*args, **kwargs):
        raise AssertionError(f"runtime created after port conflict: {args!r} {kwargs!r}")

    monkeypatch.setattr(cli_module, "create_runtime", unexpected_runtime)

    assert main(["serve", "--no-open"]) == 2
    failure = json.loads(capsys.readouterr().err)
    assert failure["error"] == {
        "code": "VALIDATION",
        "message": "localhost:3000 is already in use; refusing to start a second server",
        "retryable": False,
    }
    assert occupied.bind_calls == [("127.0.0.1", 3000)]
    assert len(occupied.options) == 1


def test_open_browser_uses_only_the_mocked_browser_boundary(monkeypatch) -> None:
    calls: list[tuple[str, int, bool]] = []
    monkeypatch.setattr(
        cli_module.webbrowser,
        "open",
        lambda url, *, new, autoraise: calls.append((url, new, autoraise)) or False,
    )

    cli_module._open_browser("http://localhost:3000/#bootstrap=redacted")

    assert calls == [("http://localhost:3000/#bootstrap=redacted", 1, True)]
