"""Explicit, no-password legacy Z-Library browser-profile migration."""

from __future__ import annotations

import os
import stat
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path

from diandianreading.domain import CredentialRef, DiandianError, ErrorCode, UnsafePathError
from diandianreading.infrastructure.acquisition.zlibrary.browser import ZLibraryBrowserPort
from diandianreading.infrastructure.acquisition.zlibrary.config import ZLibraryAdapterConfig
from diandianreading.infrastructure.acquisition.zlibrary.credentials import (
    ZLibraryCredentialResolver,
)
from diandianreading.infrastructure.acquisition.zlibrary.network import ZLibraryNetworkPolicy
from diandianreading.infrastructure.acquisition.zlibrary.selectors import (
    ZLIBRARY_SELECTORS_V1,
    ZLibrarySelectorSet,
)

_CHUNK_SIZE = 1024 * 1024


@dataclass(frozen=True, slots=True)
class LegacyProfileInspection:
    browser_profile_detected: bool
    storage_state_detected: bool
    plaintext_config_detected: bool
    warnings: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class LegacyMigrationResult:
    migrated: bool
    dry_run: bool
    source_retained: bool
    plaintext_config_detected: bool
    session_validated: bool


class ZLibraryLegacyProfileMigrator:
    """Copy only browser state; detect but never open or copy legacy config.json."""

    def __init__(
        self,
        *,
        legacy_root: Path,
        resolver: ZLibraryCredentialResolver,
        browser: ZLibraryBrowserPort,
        network_policy: ZLibraryNetworkPolicy,
        config: ZLibraryAdapterConfig,
        selectors: ZLibrarySelectorSet = ZLIBRARY_SELECTORS_V1,
    ) -> None:
        self._legacy_root = Path(os.path.abspath(legacy_root.expanduser()))
        self._resolver = resolver
        self._browser = browser
        self._network_policy = network_policy
        self._config = config
        self._selectors = selectors

    def inspect(self) -> LegacyProfileInspection:
        if not self._legacy_root.exists() and not self._legacy_root.is_symlink():
            return LegacyProfileInspection(False, False, False, ())
        _validate_directory(self._legacy_root, require_private=False)
        browser = _detect_entry(self._legacy_root / "browser_profile")
        storage = _detect_entry(self._legacy_root / "storage_state.json")
        config = _detect_entry(self._legacy_root / "config.json")
        warnings: list[str] = []
        if config:
            warnings.append(
                "Legacy config.json may contain plaintext credentials; "
                "it will not be read or migrated"
            )
        if not browser:
            warnings.append("No legacy browser profile was detected")
        return LegacyProfileInspection(
            browser_profile_detected=browser,
            storage_state_detected=storage,
            plaintext_config_detected=config,
            warnings=tuple(warnings),
        )

    async def migrate(
        self,
        credential: CredentialRef,
        *,
        confirmed: bool,
        dry_run: bool,
    ) -> LegacyMigrationResult:
        inspection = self.inspect()
        if not inspection.browser_profile_detected:
            raise DiandianError(
                ErrorCode.AUTH_REQUIRED,
                "No migratable legacy Z-Library browser profile was detected",
                retryable=False,
            )
        if self._resolver.profile_exists(credential):
            raise FileExistsError("Z-Library credential profile already exists")
        if dry_run:
            return LegacyMigrationResult(
                migrated=False,
                dry_run=True,
                source_retained=True,
                plaintext_config_detected=inspection.plaintext_config_detected,
                session_validated=False,
            )
        if not confirmed:
            raise DiandianError(
                ErrorCode.VALIDATION,
                "Z-Library legacy profile migration requires explicit confirmation",
                retryable=False,
            )

        _validate_directory(self._legacy_root, require_private=True)
        source_browser = self._legacy_root / "browser_profile"
        _validate_tree(source_browser)
        source_storage = self._legacy_root / "storage_state.json"
        if inspection.storage_state_detected:
            _validate_file(source_storage, require_private=True)

        staged = self._resolver.create_migration_staging()
        published = False
        try:
            _copy_tree_contents(source_browser, staged.browser_profile)
            if inspection.storage_state_detected:
                _copy_file(source_storage, staged.storage_state)
            self._resolver.secure_profile_tree(staged)
            _ = self._network_policy.authorize(self._config.base_url)
            authenticated = await self._browser.is_authenticated(
                browser_profile=staged.browser_profile,
                entry_url=self._config.base_url,
                network_policy=self._network_policy,
                selectors=self._selectors,
                timeout_seconds=self._config.browser_action_timeout_seconds,
            )
            self._resolver.secure_profile_tree(staged)
            if not authenticated:
                raise DiandianError(
                    ErrorCode.AUTH_REQUIRED,
                    "Legacy Z-Library browser profile did not contain a valid session",
                    retryable=False,
                )
            _ = self._resolver.publish_migration(staged, credential)
            published = True
            return LegacyMigrationResult(
                migrated=True,
                dry_run=False,
                source_retained=True,
                plaintext_config_detected=inspection.plaintext_config_detected,
                session_validated=True,
            )
        finally:
            if not published:
                with suppress(OSError):
                    self._resolver.discard_migration_staging(staged)

    def cleanup_plaintext_config(self, *, confirmed: bool) -> bool:
        config = self._legacy_root / "config.json"
        if not config.exists() and not config.is_symlink():
            return False
        if not confirmed:
            raise DiandianError(
                ErrorCode.VALIDATION,
                "Deleting legacy plaintext credentials requires separate confirmation",
                retryable=False,
            )
        _validate_file(config, require_private=True)
        config.unlink()
        return True


def _detect_entry(path: Path) -> bool:
    try:
        _ = path.lstat()
    except FileNotFoundError:
        return False
    return True


def _validate_tree(root: Path) -> None:
    _validate_directory(root, require_private=True)
    for directory, directory_names, filenames in os.walk(root, topdown=True, followlinks=False):
        directory_path = Path(directory)
        _validate_directory(directory_path, require_private=True)
        for name in directory_names:
            _validate_directory(directory_path / name, require_private=True)
        for name in filenames:
            _validate_file(directory_path / name, require_private=True)


def _copy_tree_contents(source: Path, destination: Path) -> None:
    for directory, directory_names, filenames in os.walk(source, topdown=True, followlinks=False):
        source_directory = Path(directory)
        relative = source_directory.relative_to(source)
        target_directory = destination / relative
        _validate_directory(source_directory, require_private=True)
        if relative.parts:
            target_directory.mkdir(mode=0o700)
        for name in directory_names:
            _validate_directory(source_directory / name, require_private=True)
        for name in filenames:
            _copy_file(source_directory / name, target_directory / name)


def _copy_file(source: Path, destination: Path) -> None:
    before = _validate_file(source, require_private=True)
    read_flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        read_flags |= os.O_NOFOLLOW
    source_descriptor = os.open(source, read_flags)
    write_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        write_flags |= os.O_NOFOLLOW
    try:
        opened = os.fstat(source_descriptor)
        current = source.lstat()
        _validate_file_metadata(opened, require_private=True)
        _validate_file_metadata(current, require_private=True)
        if not os.path.samestat(before, opened) or not os.path.samestat(opened, current):
            raise UnsafePathError("Legacy Z-Library profile changed while being copied")
        destination_descriptor = os.open(destination, write_flags, 0o600)
        try:
            while True:
                chunk = os.read(source_descriptor, _CHUNK_SIZE)
                if not chunk:
                    break
                _write_all(destination_descriptor, chunk)
            os.fsync(destination_descriptor)
        finally:
            os.close(destination_descriptor)
    finally:
        os.close(source_descriptor)


def _write_all(descriptor: int, content: bytes) -> None:
    offset = 0
    while offset < len(content):
        written = os.write(descriptor, content[offset:])
        if written <= 0:
            raise OSError("Legacy Z-Library profile copy failed")
        offset += written


def _validate_directory(path: Path, *, require_private: bool) -> os.stat_result:
    try:
        metadata = path.lstat()
    except FileNotFoundError as exc:
        raise UnsafePathError("Legacy Z-Library directory is missing") from exc
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise UnsafePathError("Legacy Z-Library directory must not be a symbolic link")
    _validate_owner(metadata)
    if require_private and os.name != "nt" and stat.S_IMODE(metadata.st_mode) & 0o077:
        raise UnsafePathError("Legacy Z-Library directory permissions must be private (0700)")
    return metadata


def _validate_file(path: Path, *, require_private: bool) -> os.stat_result:
    try:
        metadata = path.lstat()
    except FileNotFoundError as exc:
        raise UnsafePathError("Legacy Z-Library file is missing") from exc
    _validate_file_metadata(metadata, require_private=require_private)
    return metadata


def _validate_file_metadata(metadata: os.stat_result, *, require_private: bool) -> None:
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise UnsafePathError("Legacy Z-Library file must be a regular non-symlink file")
    _validate_owner(metadata)
    if require_private and os.name != "nt" and stat.S_IMODE(metadata.st_mode) & 0o077:
        raise UnsafePathError("Legacy Z-Library file permissions must be private (0600)")


def _validate_owner(metadata: os.stat_result) -> None:
    if os.name != "nt" and hasattr(os, "getuid") and metadata.st_uid != os.getuid():
        raise UnsafePathError("Legacy Z-Library data must be owned by the current user")
