"""Unified command-line composition root."""

from __future__ import annotations

import argparse
import asyncio
import json
import signal
import socket
import sys
import threading
import webbrowser
from collections.abc import Sequence
from enum import Enum
from pathlib import Path
from typing import Any
from urllib.parse import quote

import uvicorn

from diandianreading.application.use_cases.jobs import JobQuery
from diandianreading.domain import (
    DiandianError,
    ErrorCode,
    JobStatus,
    RightsBasis,
    UnsafePathError,
)
from diandianreading.interfaces.phase0_demo import run_phase0_demo
from diandianreading.interfaces.phase1_demo import run_phase1_demo
from diandianreading.interfaces.phase2_demo import run_phase2_demo
from diandianreading.interfaces.phase3_demo import run_phase3_demo
from diandianreading.interfaces.phase4_demo import run_phase4_demo
from diandianreading.interfaces.phase5_demo import run_phase5_demo
from diandianreading.interfaces.runtime import (
    ApplicationPaths,
    RuntimeConfig,
    create_runtime,
    notebooklm_credential,
    zlibrary_credential,
)
from diandianreading.interfaces.web import create_web_app

_SUPPORTED_CLI_RIGHTS = (
    RightsBasis.OWNED_COPY.value,
    RightsBasis.PUBLIC_DOMAIN.value,
    RightsBasis.OPEN_LICENSE.value,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="diandian", description="diandianreading local tools")
    parser.add_argument(
        "--home",
        type=Path,
        help="override the private application home (default: DIANDIAN_HOME or ~/.diandianreading)",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    auth = subparsers.add_parser("auth", help="manage isolated provider sessions")
    auth_commands = auth.add_subparsers(dest="auth_command", required=True)
    auth_login = auth_commands.add_parser("login", help="start an interactive provider login")
    auth_login.add_argument("provider", choices=("notebooklm", "zlibrary"))
    auth_login.add_argument("--profile", default="default")
    auth_status = auth_commands.add_parser("status", help="check provider session health")
    auth_status.add_argument("--notebooklm-profile", default="default")
    auth_status.add_argument("--zlibrary-profile", default="default")
    auth_logout = auth_commands.add_parser("logout", help="delete one managed local profile")
    auth_logout.add_argument("provider", choices=("notebooklm", "zlibrary"))
    auth_logout.add_argument("--profile", default="default")

    import_command = subparsers.add_parser("import", help="submit a durable book import")
    import_command.add_argument("source")
    import_command.add_argument("--provider", choices=("local", "zlibrary"), default="local")
    import_command.add_argument("--notebooklm-profile", default="default")
    import_command.add_argument("--zlibrary-profile", default="default")
    import_command.add_argument("--rights-basis", choices=_SUPPORTED_CLI_RIGHTS, required=True)
    import_command.add_argument("--rights-confirmed", action="store_true")
    import_command.add_argument("--license-identifier")
    import_command.add_argument("--title")
    import_command.add_argument("--author")
    import_command.add_argument(
        "--enable-zlibrary",
        action="store_true",
        help="explicitly enable the optional acquisition adapter for this invocation",
    )

    jobs = subparsers.add_parser("jobs", help="inspect or retry durable jobs")
    jobs_commands = jobs.add_subparsers(dest="jobs_command", required=True)
    jobs_list = jobs_commands.add_parser("list", help="list recent jobs")
    jobs_list.add_argument("--status", choices=tuple(status.value for status in JobStatus))
    jobs_list.add_argument("--limit", type=int, default=50)
    jobs_retry = jobs_commands.add_parser("retry", help="explicitly retry one failed job")
    jobs_retry.add_argument("job_id")

    worker = subparsers.add_parser("worker", help="run the durable local worker without a port")
    worker.add_argument("--once", action="store_true")
    worker.add_argument("--poll-interval", type=float, default=1.0)
    worker.add_argument("--enable-zlibrary", action="store_true")

    serve = subparsers.add_parser(
        "serve",
        help="serve the secured Web/API and worker on http://localhost:3000",
    )
    serve.add_argument("--no-open", action="store_true", help="do not open the system browser")
    serve.add_argument("--enable-zlibrary", action="store_true")

    phase0 = subparsers.add_parser(
        "phase0-e2e",
        help="run the local fake import E2E and verify SQLite persistence",
    )
    phase0.add_argument("--database", type=Path, required=True)
    phase0.add_argument("--workspace", type=Path, required=True)

    phase1 = subparsers.add_parser(
        "phase1-e2e",
        help="run local Markdown, EPUB, and PDF preparation through SQLite persistence",
    )
    phase1.add_argument("--database", type=Path, required=True)
    phase1.add_argument("--object-root", type=Path, required=True)
    phase1.add_argument("--workspace", type=Path, required=True)

    phase2 = subparsers.add_parser(
        "phase2-e2e",
        help="run the NotebookLM adapter through an in-process SDK double",
    )
    phase2.add_argument("--database", type=Path, required=True)
    phase2.add_argument("--object-root", type=Path, required=True)
    phase2.add_argument("--credentials-root", type=Path, required=True)
    phase2.add_argument("--workspace", type=Path, required=True)

    phase3 = subparsers.add_parser(
        "phase3-e2e",
        help="run crash-boundary recovery, auth resume, ambiguity, and cancellation E2E",
    )
    phase3.add_argument("--database", type=Path, required=True)
    phase3.add_argument("--workspace", type=Path, required=True)

    phase4 = subparsers.add_parser(
        "phase4-e2e",
        help="run governed Z-Library acquisition through browser and network doubles",
    )
    phase4.add_argument("--database", type=Path, required=True)
    phase4.add_argument("--object-root", type=Path, required=True)
    phase4.add_argument("--credentials-root", type=Path, required=True)
    phase4.add_argument("--workspace", type=Path, required=True)

    phase5 = subparsers.add_parser(
        "phase5-e2e",
        help="run the secured local API, worker, import, and whole-book chat E2E",
    )
    phase5.add_argument("--app-home", type=Path, required=True)
    phase5.add_argument("--workspace", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "serve":
            return _serve(args)
        if args.command == "phase5-e2e":
            _print_result(run_phase5_demo(args.app_home, args.workspace))
            return 0
        if args.command in {"auth", "import", "jobs", "worker"}:
            result = asyncio.run(_run_product_command(args))
            _print_result(result)
            return 0
        if args.command == "phase0-e2e":
            _print_result(asyncio.run(run_phase0_demo(args.database, args.workspace)))
            return 0
        if args.command == "phase1-e2e":
            _print_result(
                asyncio.run(run_phase1_demo(args.database, args.object_root, args.workspace))
            )
            return 0
        if args.command == "phase2-e2e":
            _print_result(
                asyncio.run(
                    run_phase2_demo(
                        args.database,
                        args.object_root,
                        args.credentials_root,
                        args.workspace,
                    )
                )
            )
            return 0
        if args.command == "phase3-e2e":
            _print_result(asyncio.run(run_phase3_demo(args.database, args.workspace)))
            return 0
        if args.command == "phase4-e2e":
            _print_result(
                asyncio.run(
                    run_phase4_demo(
                        args.database,
                        args.object_root,
                        args.credentials_root,
                        args.workspace,
                    )
                )
            )
            return 0
        return _emit_error(
            ErrorCode.VALIDATION,
            "Unsupported command",
            retryable=False,
            exit_code=2,
        )
    except KeyboardInterrupt:
        return _emit_error(
            ErrorCode.CANCELLED,
            "Command interrupted",
            retryable=False,
            exit_code=130,
        )
    except (FileExistsError, UnsafePathError, ValueError) as error:
        code = error.code if isinstance(error, DiandianError) else ErrorCode.VALIDATION
        message = error.public_message if isinstance(error, DiandianError) else str(error)
        return _emit_error(code, message, retryable=False, exit_code=2)
    except DiandianError as error:
        return _emit_error(
            error.code,
            error.public_message,
            retryable=error.retryable,
            exit_code=3,
        )
    except OSError:
        return _emit_error(
            ErrorCode.UNEXPECTED,
            "Local storage or network operation failed",
            retryable=False,
            exit_code=4,
        )
    except Exception:
        return _emit_error(
            ErrorCode.UNEXPECTED,
            "Unexpected command failure",
            retryable=False,
            exit_code=1,
        )


async def _run_product_command(args: argparse.Namespace) -> dict[str, object]:
    zlibrary_override = True if getattr(args, "enable_zlibrary", False) else None
    runtime = create_runtime(
        _paths(args.home),
        config=RuntimeConfig.from_environment(zlibrary_enabled=zlibrary_override),
    )
    try:
        if args.command == "auth":
            return await _run_auth(runtime, args)
        if args.command == "import":
            return await _run_import(runtime, args)
        if args.command == "jobs":
            return _run_jobs(runtime, args)
        if args.command == "worker":
            return await _run_worker(runtime, args)
        raise ValueError("Unsupported product command")
    finally:
        await runtime.aclose()


async def _run_auth(runtime: Any, args: argparse.Namespace) -> dict[str, object]:
    if args.auth_command == "status":
        notebook_status, zlibrary_status = await asyncio.gather(
            runtime.notebooklm_session.status(notebooklm_credential(args.notebooklm_profile)),
            runtime.zlibrary_session.status(zlibrary_credential(args.zlibrary_profile)),
        )
        return {
            "status": "ok",
            "providers": {
                "notebooklm": _provider_status(notebook_status),
                "zlibrary": _provider_status(zlibrary_status),
            },
        }

    credential = (
        notebooklm_credential(args.profile)
        if args.provider == "notebooklm"
        else zlibrary_credential(args.profile)
    )
    manager = (
        runtime.notebooklm_session if args.provider == "notebooklm" else runtime.zlibrary_session
    )
    if args.auth_command == "login":
        status = await manager.login(credential)
        return {"status": "ok", "provider": _provider_status(status)}
    if args.auth_command == "logout":
        removed = manager.logout(credential)
        if asyncio.iscoroutine(removed):
            removed = await removed
        return {
            "status": "ok",
            "provider": args.provider,
            "profile": args.profile,
            "local_profile_removed": bool(removed),
        }
    raise ValueError("Unsupported auth command")


async def _run_import(runtime: Any, args: argparse.Namespace) -> dict[str, object]:
    if not args.rights_confirmed:
        raise ValueError("Import requires --rights-confirmed for this specific item")
    rights_basis = RightsBasis(args.rights_basis)
    if (
        rights_basis in {RightsBasis.PUBLIC_DOMAIN, RightsBasis.OPEN_LICENSE}
        and not (args.license_identifier or "").strip()
    ):
        raise ValueError("Public-domain and open-license imports require --license-identifier")

    if args.provider == "local":
        job = await runtime.import_submission.submit_local(
            Path(args.source),
            rights_basis=rights_basis,
            license_identifier=args.license_identifier,
            evidence_storage_key=None,
            rights_confirmed=True,
            target_credential=notebooklm_credential(args.notebooklm_profile),
            target_capabilities=runtime.target_capabilities,
            title=args.title,
            author=args.author,
        )
    else:
        if not runtime.zlibrary_enabled:
            raise ValueError(
                "Z-Library is disabled; pass --enable-zlibrary or set "
                "DIANDIAN_ZLIBRARY_ENABLED=true"
            )
        if not (args.title or "").strip():
            raise ValueError("Z-Library imports require --title")
        job = runtime.import_submission.submit_zlibrary(
            args.source,
            acquisition_credential=zlibrary_credential(args.zlibrary_profile),
            target_credential=notebooklm_credential(args.notebooklm_profile),
            rights_basis=rights_basis,
            license_identifier=args.license_identifier,
            evidence_storage_key=None,
            attestation_version="zlibrary-rights-v1",
            rights_confirmed=True,
            target_capabilities=runtime.target_capabilities,
            title=args.title,
            author=args.author,
        )
    return {"status": "ok", "job": _job_view(runtime.jobs.get(job.id))}


def _run_jobs(runtime: Any, args: argparse.Namespace) -> dict[str, object]:
    if args.jobs_command == "list":
        status = JobStatus(args.status) if args.status is not None else None
        page = runtime.jobs.list(JobQuery(status=status, limit=args.limit))
        return {
            "status": "ok",
            "jobs": [_job_view(item) for item in page.items],
            "next_cursor": (
                {
                    "created_at": page.next_cursor.created_at.isoformat(),
                    "id": page.next_cursor.id,
                }
                if page.next_cursor is not None
                else None
            ),
        }
    if args.jobs_command == "retry":
        return {"status": "ok", "job": _job_view(runtime.jobs.retry(args.job_id))}
    raise ValueError("Unsupported jobs command")


async def _run_worker(runtime: Any, args: argparse.Namespace) -> dict[str, object]:
    if args.once:
        handled = await runtime.worker.run_once()
        return {"status": "ok", "handled": handled}
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    installed_signals: list[signal.Signals] = []
    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(signum, stop.set)
            installed_signals.append(signum)
        except (NotImplementedError, RuntimeError):
            continue
    try:
        await runtime.worker.run_forever(stop, poll_interval=args.poll_interval)
    finally:
        for signum in installed_signals:
            loop.remove_signal_handler(signum)
    return {"status": "ok", "stopped": True}


def _serve(args: argparse.Namespace) -> int:
    _require_port_3000_available()
    zlibrary_override = True if args.enable_zlibrary else None
    runtime = create_runtime(
        _paths(args.home),
        config=RuntimeConfig.from_environment(zlibrary_enabled=zlibrary_override),
    )
    app = create_web_app(runtime)
    if not args.no_open:
        nonce = runtime.security.issue_bootstrap()
        url = f"http://localhost:3000/#bootstrap={quote(nonce.nonce, safe='')}"
        timer = threading.Timer(0.8, _open_browser, args=(url,))
        timer.daemon = True
        timer.start()
    print(
        json.dumps(
            {
                "status": "starting",
                "origin": "http://localhost:3000",
                "worker": "enabled",
                "zlibrary": "enabled" if runtime.zlibrary_enabled else "disabled",
            },
            ensure_ascii=False,
            sort_keys=True,
        ),
        flush=True,
    )
    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=3000,
        access_log=False,
        proxy_headers=False,
        server_header=False,
        ws="none",
        limit_concurrency=64,
        timeout_keep_alive=5,
        timeout_graceful_shutdown=10,
        h11_max_incomplete_event_size=16 * 1024,
        log_level="warning",
    )
    uvicorn.Server(config).run()
    return 0


def _paths(home: Path | None) -> ApplicationPaths:
    return ApplicationPaths(home) if home is not None else ApplicationPaths.default()


def _provider_status(status: Any) -> dict[str, object]:
    state = status.state.value if isinstance(status.state, Enum) else str(status.state)
    return {
        "provider": status.provider,
        "profile": status.profile,
        "state": state,
        "checked_at": status.checked_at.isoformat(),
    }


def _job_view(view: Any) -> dict[str, object]:
    return {
        "id": view.id,
        "job_type": view.job_type,
        "book_title": view.book_title,
        "status": view.status.value,
        "current_step": view.current_step.value if view.current_step is not None else None,
        "attempt": view.attempt,
        "progress_current": view.progress_current,
        "progress_total": view.progress_total,
        "last_error_code": (
            view.last_error_code.value if view.last_error_code is not None else None
        ),
        "retriable": view.retriable,
        "blocked_reason": (view.blocked_reason.value if view.blocked_reason is not None else None),
        "book_id": view.book_id,
        "created_at": view.created_at.isoformat(),
        "updated_at": view.updated_at.isoformat(),
        "completed_at": (view.completed_at.isoformat() if view.completed_at is not None else None),
    }


def _require_port_3000_available() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", 3000))
        except OSError as error:
            raise ValueError(
                "localhost:3000 is already in use; refusing to start a second server"
            ) from error


def _open_browser(url: str) -> None:
    try:
        _ = webbrowser.open(url, new=1, autoraise=True)
    finally:
        url = ""


def _print_result(result: dict[str, object]) -> None:
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))


def _emit_error(
    code: ErrorCode,
    message: str,
    *,
    retryable: bool,
    exit_code: int,
) -> int:
    payload: dict[str, Any] = {
        "status": "error",
        "error": {
            "code": code.value,
            "message": message,
            "retryable": retryable,
        },
    }
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True), file=sys.stderr)
    return exit_code
