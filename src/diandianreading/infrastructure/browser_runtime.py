"""Private, versioned Playwright Chromium provisioning for the local Web tool."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass
from enum import StrEnum
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from uuid import uuid4

BROWSER_MANIFEST_FORMAT = "diandian-browser-manifest-v1"
BROWSER_MANIFEST_FILENAME = "browser-manifest.json"
_BROWSER_EXECUTABLE_NAMES = frozenset(
    {"chromium", "chrome", "chrome.exe", "google chrome for testing"}
)


class BrowserRuntimeError(RuntimeError):
    """A browser runtime cannot be trusted or provisioned."""


class BrowserRuntimeState(StrEnum):
    READY = "ready"
    MISSING = "missing"
    CORRUPT = "corrupt"
    VERSION_MISMATCH = "version_mismatch"
    SUPPORT_MISSING = "support_missing"


@dataclass(frozen=True, slots=True)
class BrowserRuntimeStatus:
    state: BrowserRuntimeState
    playwright_version: str | None
    revision: str | None = None
    installed_bytes: int | None = None


BrowserInstaller = Callable[[Path, bool], None]


class BrowserRuntimeManager:
    """Own one Playwright revision below the private application home."""

    def __init__(
        self,
        root: Path,
        *,
        playwright_version: str | None = None,
        installer: BrowserInstaller | None = None,
    ) -> None:
        self._root = Path(os.path.abspath(root.expanduser()))
        self._playwright_version = (
            _installed_playwright_version() if playwright_version is None else playwright_version
        )
        if self._playwright_version is not None and not _safe_version(self._playwright_version):
            raise ValueError("Playwright version is invalid")
        self._installer = installer or _install_chromium

    @property
    def root(self) -> Path:
        return self._root

    @property
    def version_root(self) -> Path | None:
        if self._playwright_version is None:
            return None
        return self._root / f"playwright-{self._playwright_version}"

    def inspect(self) -> BrowserRuntimeStatus:
        if self._playwright_version is None:
            return BrowserRuntimeStatus(BrowserRuntimeState.SUPPORT_MISSING, None)
        version_root = self.version_root
        assert version_root is not None
        try:
            self._validate_private_root_if_present()
        except (BrowserRuntimeError, OSError):
            return BrowserRuntimeStatus(BrowserRuntimeState.CORRUPT, self._playwright_version)
        if not version_root.exists():
            state = (
                BrowserRuntimeState.VERSION_MISMATCH
                if self._other_manifests_exist()
                else BrowserRuntimeState.MISSING
            )
            return BrowserRuntimeStatus(state, self._playwright_version)
        try:
            payload = self._read_valid_manifest(version_root)
        except (BrowserRuntimeError, OSError, ValueError):
            return BrowserRuntimeStatus(BrowserRuntimeState.CORRUPT, self._playwright_version)
        installed_bytes = payload["installed_bytes"]
        revision = payload["revision"]
        assert type(installed_bytes) is int
        assert isinstance(revision, str)
        return BrowserRuntimeStatus(
            BrowserRuntimeState.READY,
            self._playwright_version,
            revision=revision,
            installed_bytes=installed_bytes,
        )

    def provision(self, *, force: bool = False, quiet: bool = False) -> BrowserRuntimeStatus:
        if self._playwright_version is None:
            raise BrowserRuntimeError(
                "NotebookLM browser support is not installed in this tool environment"
            )
        current = self.inspect()
        if current.state is BrowserRuntimeState.READY and not force:
            return current
        destination = self.version_root
        assert destination is not None
        if destination.exists() and not force:
            raise BrowserRuntimeError(
                "The managed Chromium runtime is invalid; rerun setup with --force"
            )

        self._prepare_private_root()
        staging = self._root / f".staging-{uuid4().hex}"
        previous = self._root / f".previous-{uuid4().hex}"
        published = False
        moved_previous = False
        try:
            staging.mkdir(mode=0o700)
            self._installer(staging, quiet)
            executable = _browser_executable(staging)
            if executable is None:
                raise BrowserRuntimeError(
                    "Playwright setup did not create a supported Chromium executable"
                )
            resolved_executable = executable.resolve(strict=True)
            if self._root not in resolved_executable.parents:
                raise BrowserRuntimeError("Chromium executable escaped the managed browser root")
            revision_root = next(
                (parent for parent in resolved_executable.parents if parent.parent == staging),
                None,
            )
            if revision_root is None:
                raise BrowserRuntimeError("Chromium revision directory is invalid")
            installed_bytes = sum(
                path.stat().st_size for path in staging.rglob("*") if path.is_file()
            )
            manifest = {
                "format": BROWSER_MANIFEST_FORMAT,
                "browser": "chromium",
                "playwright_version": self._playwright_version,
                "revision": revision_root.name,
                "executable": str(resolved_executable.relative_to(staging)),
                "executable_sha256": _sha256(resolved_executable),
                "installed_bytes": installed_bytes,
            }
            (staging / BROWSER_MANIFEST_FILENAME).write_text(
                json.dumps(manifest, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            _ = self._read_valid_manifest(staging)
            if destination.exists():
                os.replace(destination, previous)
                moved_previous = True
            os.replace(staging, destination)
            published = True
            status = self.inspect()
            if status.state is not BrowserRuntimeState.READY:
                _remove_path(destination)
                if moved_previous:
                    os.replace(previous, destination)
                    moved_previous = False
                published = False
                raise BrowserRuntimeError("Published Chromium runtime failed validation")
            if moved_previous:
                _remove_path(previous)
            return status
        except BrowserRuntimeError:
            raise
        except (OSError, subprocess.SubprocessError) as error:
            raise BrowserRuntimeError("Chromium setup failed safely") from error
        finally:
            if not published:
                _remove_path(staging)
                if moved_previous and previous.exists() and not destination.exists():
                    os.replace(previous, destination)
            _remove_path(previous)

    def configure_environment(self) -> BrowserRuntimeStatus:
        status = self.inspect()
        if status.state is BrowserRuntimeState.READY:
            version_root = self.version_root
            assert version_root is not None
            os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(version_root)
        return status

    def _read_valid_manifest(self, version_root: Path) -> dict[str, object]:
        self._validate_private_root_if_present()
        try:
            metadata = version_root.lstat()
        except FileNotFoundError as error:
            raise BrowserRuntimeError("Chromium version root is missing") from error
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise BrowserRuntimeError("Chromium version root is invalid")
        manifest_path = version_root / BROWSER_MANIFEST_FILENAME
        try:
            manifest_metadata = manifest_path.lstat()
            if (
                not stat.S_ISREG(manifest_metadata.st_mode)
                or stat.S_ISLNK(manifest_metadata.st_mode)
                or manifest_metadata.st_size > 32_768
            ):
                raise BrowserRuntimeError("Chromium manifest is invalid")
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise BrowserRuntimeError("Chromium manifest is invalid") from error
        if not isinstance(payload, dict):
            raise BrowserRuntimeError("Chromium manifest is invalid")
        required = {
            "format",
            "browser",
            "playwright_version",
            "revision",
            "executable",
            "executable_sha256",
            "installed_bytes",
        }
        if set(payload) != required:
            raise BrowserRuntimeError("Chromium manifest fields are invalid")
        executable = payload.get("executable")
        digest = payload.get("executable_sha256")
        installed_bytes = payload.get("installed_bytes")
        revision = payload.get("revision")
        if (
            payload.get("format") != BROWSER_MANIFEST_FORMAT
            or payload.get("browser") != "chromium"
            or payload.get("playwright_version") != self._playwright_version
            or not isinstance(revision, str)
            or not revision.startswith("chromium-")
            or not _safe_version(revision)
            or not isinstance(executable, str)
            or not isinstance(digest, str)
            or len(digest) != 64
            or type(installed_bytes) is not int
            or installed_bytes <= 0
        ):
            raise BrowserRuntimeError("Chromium manifest values are invalid")
        executable_path = (version_root / executable).resolve(strict=True)
        if (
            version_root not in executable_path.parents
            or not executable_path.relative_to(version_root).parts
            or executable_path.relative_to(version_root).parts[0] != revision
        ):
            raise BrowserRuntimeError("Chromium executable escaped its version root")
        metadata = executable_path.stat()
        if not stat.S_ISREG(metadata.st_mode) or not os.access(executable_path, os.X_OK):
            raise BrowserRuntimeError("Chromium executable is invalid")
        if _sha256(executable_path) != digest:
            raise BrowserRuntimeError("Chromium executable integrity check failed")
        return payload

    def _prepare_private_root(self) -> None:
        parent = self._root.parent
        parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if os.name != "nt":
            parent.chmod(0o700)
        self._reject_symlink(self._root)
        self._root.mkdir(exist_ok=True, mode=0o700)
        if os.name != "nt":
            self._root.chmod(0o700)
        self._validate_private_root_if_present()

    def _validate_private_root_if_present(self) -> None:
        if not self._root.exists():
            return
        metadata = self._root.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise BrowserRuntimeError("Managed browser root is invalid")
        if os.name != "nt" and (
            metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) & 0o077
        ):
            raise BrowserRuntimeError("Managed browser root permissions are unsafe")

    def _other_manifests_exist(self) -> bool:
        try:
            return any(self._root.glob(f"playwright-*/{BROWSER_MANIFEST_FILENAME}"))
        except OSError:
            return False

    @staticmethod
    def _reject_symlink(path: Path) -> None:
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            return
        if stat.S_ISLNK(metadata.st_mode):
            raise BrowserRuntimeError("Managed browser root cannot be a symbolic link")


def _installed_playwright_version() -> str | None:
    try:
        return version("playwright")
    except PackageNotFoundError:
        return None


def _safe_version(value: str) -> bool:
    return (
        bool(value)
        and len(value) <= 64
        and all(character.isalnum() or character in {".", "-", "_"} for character in value)
    )


def _browser_executable(root: Path) -> Path | None:
    return next(
        (
            path
            for path in root.rglob("*")
            if path.is_file() and path.name.casefold() in _BROWSER_EXECUTABLE_NAMES
        ),
        None,
    )


def _install_chromium(output: Path, quiet: bool) -> None:
    environment = {**os.environ, "PLAYWRIGHT_BROWSERS_PATH": str(output)}
    stream = subprocess.DEVNULL if quiet else None
    subprocess.run(
        [sys.executable, "-m", "playwright", "install", "chromium"],
        check=True,
        env=environment,
        stdout=stream,
        stderr=stream,
    )


def _remove_path(path: Path) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return
    except OSError:
        return
    if stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode):
        shutil.rmtree(path, ignore_errors=True)
    else:
        with suppress(OSError):
            path.unlink()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
