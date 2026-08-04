#!/usr/bin/env python3
"""Build a target-specific, inspectable Python sidecar artifact.

Run from the repository root after installing the locked ``desktop-sidecar``
extra.  This intentionally creates an onedir artifact: its files are separately
hashable and suitable for later Tauri embedding/codesigning.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENTRYPOINT = ROOT / "packaging" / "sidecar" / "entrypoint.py"
PACKAGE_DATA = (
    "diandianreading/infrastructure/persistence/migrations/0001_initial.sql",
    "diandianreading/interfaces/web/static/index.html",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="build the diandian desktop Python sidecar")
    parser.add_argument(
        "--output", type=Path, required=True, help="empty target artifact directory"
    )
    parser.add_argument(
        "--browser-root",
        type=Path,
        required=True,
        help="provisioned Chromium directory containing browser-manifest.json",
    )
    return parser.parse_args()


def _target_triple() -> str:
    if platform.system() != "Darwin":
        raise ValueError("D1 sidecar artifacts are currently built only on macOS")
    architecture = platform.machine()
    targets = {"arm64": "aarch64-apple-darwin", "x86_64": "x86_64-apple-darwin"}
    try:
        return targets[architecture]
    except KeyError as error:
        raise ValueError(f"Unsupported macOS architecture: {architecture}") from error


def _validate_browser_root(browser_root: Path) -> Path:
    root = browser_root.resolve()
    manifest = root / "browser-manifest.json"
    if not root.is_dir() or not manifest.is_file():
        raise ValueError("Browser provisioning is missing or invalid")
    try:
        payload = json.loads(manifest.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError("Browser provisioning manifest is invalid") from error
    executable = payload.get("executable")
    if (
        payload.get("browser") != "chromium"
        or not isinstance(payload.get("revision"), str)
        or not isinstance(executable, str)
    ):
        raise ValueError("Browser provisioning manifest is invalid")
    executable_path = (root / executable).resolve()
    if root not in executable_path.parents or not executable_path.is_file():
        raise ValueError("Browser provisioning executable is missing")
    return root


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_manifest(artifact: Path, target: str) -> None:
    files = sorted(path for path in artifact.rglob("*") if path.is_file())
    manifest = {
        "format": "diandian-sidecar-manifest-v1",
        "target": target,
        "files": [
            {
                "path": str(path.relative_to(artifact)),
                "sha256": _sha256(path),
                "bytes": path.stat().st_size,
            }
            for path in files
        ],
    }
    (artifact / "sidecar-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def main() -> int:
    args = parse_args()
    target = _target_triple()
    browser_root = _validate_browser_root(args.browser_root)
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()):
        raise ValueError("Output artifact directory must be empty")
    output.mkdir(parents=True, exist_ok=True)
    work = output / ".work"
    spec = output / ".spec"
    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onedir",
        "--name",
        "diandian-desktop-sidecar",
        "--distpath",
        str(output),
        "--workpath",
        str(work),
        "--specpath",
        str(spec),
        "--paths",
        str(ROOT / "src"),
        "--collect-data",
        "diandianreading",
        "--collect-submodules",
        "diandianreading",
        "--collect-submodules",
        "notebooklm",
        "--exclude-module",
        "notebooklm.server",
        "--collect-submodules",
        "playwright",
        str(ENTRYPOINT),
    ]
    try:
        subprocess.run(command, cwd=ROOT, check=True)
        artifact = output / "diandian-desktop-sidecar"
        if not artifact.is_dir():
            raise ValueError("PyInstaller did not produce the expected sidecar directory")
        shutil.copytree(browser_root, artifact / "_internal" / "playwright-browsers")
        for resource in PACKAGE_DATA:
            if not (artifact / "_internal" / resource).is_file():
                raise ValueError(f"Required packaged resource is missing: {resource}")
        _write_manifest(artifact, target)
    finally:
        shutil.rmtree(work, ignore_errors=True)
        shutil.rmtree(spec, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
