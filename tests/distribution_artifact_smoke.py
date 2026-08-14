#!/usr/bin/env python3
"""Validate release archives without installing or executing their contents."""

from __future__ import annotations

import argparse
import configparser
import hashlib
import json
import re
import tarfile
import tomllib
import zipfile
from email.parser import Parser
from pathlib import Path, PurePosixPath
from typing import Any

MAX_WHEEL_BYTES = 10 * 1024 * 1024
MAX_ARCHIVE_CONTENT_BYTES = 50 * 1024 * 1024
_SECRET_MARKERS = (
    b"-----BEGIN " + b"PRIVATE KEY-----",
    b"-----BEGIN " + b"RSA PRIVATE KEY-----",
    b"-----BEGIN " + b"EC PRIVATE KEY-----",
    b"-----BEGIN " + b"OPENSSH PRIVATE KEY-----",
)
_SECRET_PATTERNS = (
    re.compile(rb"gh[pousr]_[A-Za-z0-9]{36,}"),
    re.compile(rb"pypi-[A-Za-z0-9_-]{50,}"),
    re.compile(rb"AIza[0-9A-Za-z_-]{35}"),
)
FORBIDDEN_COMPONENTS = frozenset(
    {
        ".env",
        ".diandianreading",
        "browsers",
        "credentials",
        "install-token.json",
        "master_token.json",
        "storage_state.json",
    }
)
FORBIDDEN_SUFFIXES = frozenset({".app", ".db", ".dylib", ".exe", ".sqlite", ".sqlite3"})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wheel", type=Path, required=True)
    parser.add_argument("--sdist", type=Path, required=True)
    parser.add_argument("--lock", type=Path, default=Path("uv.lock"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    wheel = args.wheel.resolve(strict=True)
    sdist = args.sdist.resolve(strict=True)
    lock = args.lock.resolve(strict=True)
    wheel_names, metadata, entry_points = _inspect_wheel(wheel)
    sdist_names = _inspect_sdist(sdist)

    migration_names = sorted(
        name
        for name in wheel_names
        if name.startswith("diandianreading/infrastructure/persistence/migrations/")
        and name.endswith(".sql")
    )
    if not migration_names:
        raise ValueError("wheel does not contain database migrations")
    migration_versions = [
        int(PurePosixPath(name).name.split("_", 1)[0]) for name in migration_names
    ]
    if migration_versions != list(range(1, migration_versions[-1] + 1)):
        raise ValueError("wheel migrations are not a contiguous sequence")
    schema_version = migration_versions[-1]

    _require_name(wheel_names, "diandianreading/interfaces/web/static/index.html")
    _require_suffix(wheel_names, ".js", below="diandianreading/interfaces/web/static/assets/")
    _require_fragment(wheel_names, "pdf.worker.min-")
    _require_name(wheel_names, "diandianreading/infrastructure/browser_runtime.py")
    _reject_private_or_bundled_files(wheel_names)
    if wheel.stat().st_size > MAX_WHEEL_BYTES:
        raise ValueError("wheel is unexpectedly large and may contain a browser runtime")

    scripts = _console_scripts(entry_points)
    expected_scripts = {
        "diandian": "diandianreading.interfaces.cli:main",
        "diandianreading": "diandianreading.interfaces.cli:main",
    }
    if scripts != expected_scripts:
        raise ValueError("wheel console scripts do not match the public CLI contract")

    sdist_root = PurePosixPath(next(iter(sdist_names))).parts[0]
    for relative in (
        "README.md",
        "CHANGELOG.md",
        "SECURITY.md",
        "diandianreading-PRD.md",
        "diandianreading-ROADMAP.md",
        "pyproject.toml",
        "uv.lock",
    ):
        _require_name(sdist_names, f"{sdist_root}/{relative}")

    if metadata["Requires-Python"] != "<3.15,>=3.11":
        raise ValueError("wheel Python range does not match the tested support matrix")

    runtime_requires = metadata.get_all("Requires-Dist", failobj=[])
    expected_runtime_requires = {
        "fastapi==0.141.1",
        "notebooklm-py[browser]==0.8.0rc1",
        "playwright==1.61.0",
        "uvicorn==0.52.3",
    }
    if set(runtime_requires) != expected_runtime_requires:
        raise ValueError("wheel runtime requirements are not the reviewed exact set")

    result: dict[str, Any] = {
        "status": "ok",
        "package": metadata["Name"],
        "version": metadata["Version"],
        "requires_python": metadata["Requires-Python"],
        "schema_version": schema_version,
        "playwright": "1.61.0",
        "chromium_bundled": False,
        "console_scripts": scripts,
        "runtime_requires": sorted(runtime_requires),
        "lock": _artifact_record(lock),
        "locked_packages": _lock_inventory(lock),
        "wheel": _artifact_record(wheel),
        "sdist": _artifact_record(sdist),
    }
    rendered = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output is not None:
        output = args.output.resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    return 0


def _inspect_wheel(path: Path) -> tuple[set[str], Any, str]:
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        _reject_unsafe_archive_names(names)
        _scan_zip_for_secret_markers(archive)
        metadata_name = _one_name(names, suffix=".dist-info/METADATA")
        entry_points_name = _one_name(names, suffix=".dist-info/entry_points.txt")
        metadata = Parser().parsestr(archive.read(metadata_name).decode("utf-8"))
        entry_points = archive.read(entry_points_name).decode("utf-8")
    return names, metadata, entry_points


def _inspect_sdist(path: Path) -> set[str]:
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        if any(member.issym() or member.islnk() for member in members):
            raise ValueError("sdist contains a symbolic or hard link")
        _scan_tar_for_secret_markers(archive, members)
        names = {member.name for member in members}
    _reject_unsafe_archive_names(names)
    if not names:
        raise ValueError("sdist is empty")
    return names


def _scan_zip_for_secret_markers(archive: zipfile.ZipFile) -> None:
    total = 0
    for info in archive.infolist():
        if info.is_dir():
            continue
        total += info.file_size
        if total > MAX_ARCHIVE_CONTENT_BYTES:
            raise ValueError("distribution expands beyond the inspection limit")
        _reject_secret_markers(archive.read(info))


def _scan_tar_for_secret_markers(archive: tarfile.TarFile, members: list[tarfile.TarInfo]) -> None:
    total = 0
    for member in members:
        if not member.isfile():
            continue
        total += member.size
        if total > MAX_ARCHIVE_CONTENT_BYTES:
            raise ValueError("distribution expands beyond the inspection limit")
        source = archive.extractfile(member)
        if source is None:
            raise ValueError("sdist file content is unavailable")
        _reject_secret_markers(source.read())


def _reject_secret_markers(payload: bytes) -> None:
    if any(marker in payload for marker in _SECRET_MARKERS) or any(
        pattern.search(payload) for pattern in _SECRET_PATTERNS
    ):
        raise ValueError("distribution contains a high-signal secret marker")


def _reject_unsafe_archive_names(names: set[str]) -> None:
    for name in names:
        parsed = PurePosixPath(name)
        if parsed.is_absolute() or ".." in parsed.parts or "\\" in name:
            raise ValueError("distribution contains an unsafe archive path")


def _reject_private_or_bundled_files(names: set[str]) -> None:
    for name in names:
        path = PurePosixPath(name)
        folded_parts = {part.casefold() for part in path.parts}
        if folded_parts & FORBIDDEN_COMPONENTS:
            raise ValueError("wheel contains a private application-state path")
        if path.suffix.casefold() in FORBIDDEN_SUFFIXES:
            raise ValueError("wheel contains an unexpected native or state artifact")
        folded = name.casefold()
        if "chromium-" in folded or "chrome-mac" in folded or "chrome-linux" in folded:
            raise ValueError("wheel contains a Chromium runtime")


def _console_scripts(payload: str) -> dict[str, str]:
    config = configparser.ConfigParser()
    config.read_string(payload)
    if set(config.sections()) != {"console_scripts"}:
        raise ValueError("wheel entry points contain an unexpected group")
    return dict(config.items("console_scripts"))


def _lock_inventory(path: Path) -> list[dict[str, str]]:
    with path.open("rb") as source:
        payload = tomllib.load(source)
    packages = payload.get("package")
    if not isinstance(packages, list):
        raise ValueError("lockfile package inventory is invalid")
    inventory: list[dict[str, str]] = []
    for package in packages:
        if not isinstance(package, dict):
            raise ValueError("lockfile package inventory is invalid")
        name = package.get("name")
        version = package.get("version")
        if not isinstance(name, str) or not isinstance(version, str):
            raise ValueError("lockfile package inventory is invalid")
        inventory.append({"name": name, "version": version})
    return sorted(inventory, key=lambda item: (item["name"], item["version"]))


def _artifact_record(path: Path) -> dict[str, object]:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"filename": path.name, "sha256": digest.hexdigest(), "size": path.stat().st_size}


def _one_name(names: set[str], *, suffix: str) -> str:
    matching = [name for name in names if name.endswith(suffix)]
    if len(matching) != 1:
        raise ValueError(f"distribution must contain exactly one {suffix}")
    return matching[0]


def _require_name(names: set[str], expected: str) -> None:
    if expected not in names:
        raise ValueError(f"distribution resource is missing: {expected}")


def _require_suffix(names: set[str], suffix: str, *, below: str) -> None:
    if not any(name.startswith(below) and name.endswith(suffix) for name in names):
        raise ValueError(f"distribution has no {suffix} resource below {below}")


def _require_fragment(names: set[str], fragment: str) -> None:
    if not any(fragment in name for name in names):
        raise ValueError(f"distribution resource is missing: {fragment}")


if __name__ == "__main__":
    raise SystemExit(main())
