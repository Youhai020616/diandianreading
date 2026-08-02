"""Command-line composition root."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from diandianreading.domain import DiandianError, ErrorCode, UnsafePathError
from diandianreading.interfaces.phase0_demo import run_phase0_demo
from diandianreading.interfaces.phase1_demo import run_phase1_demo


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="diandian", description="diandianreading local tools")
    subparsers = parser.add_subparsers(dest="command", required=True)

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
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "phase0-e2e":
            result = asyncio.run(run_phase0_demo(args.database, args.workspace))
            print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
            return 0
        if args.command == "phase1-e2e":
            result = asyncio.run(run_phase1_demo(args.database, args.object_root, args.workspace))
            print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
            return 0
        return _emit_error(
            ErrorCode.VALIDATION, "Unsupported command", retryable=False, exit_code=2
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
            "Local storage operation failed",
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
