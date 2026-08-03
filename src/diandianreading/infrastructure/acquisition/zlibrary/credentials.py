"""Provider-isolated Z-Library browser profile resolution and lifecycle."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, cast

from diandianreading.domain import CredentialRef, DiandianError, ErrorCode, UnsafePathError

_MAX_STORAGE_STATE_BYTES = 16 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class ZLibraryProfilePaths:
    profile_directory: Path
    browser_profile: Path
    storage_state: Path


class ZLibraryCredentialResolver:
    provider = "zlibrary"

    def __init__(self, credentials_root: Path) -> None:
        self._root = Path(os.path.abspath(credentials_root.expanduser()))
        self._prepare_root()

    def prepare_profile(self, credential: CredentialRef) -> ZLibraryProfilePaths:
        self._validate_credential(credential)
        provider_root = self._ensure_private_directory(self._root / self.provider)
        profiles_root = self._ensure_private_directory(provider_root / "profiles")
        profile = self._ensure_private_directory(
            profiles_root / self.profile_key(credential.profile)
        )
        browser_profile = self._ensure_private_directory(profile / "browser_profile")
        return ZLibraryProfilePaths(
            profile_directory=profile,
            browser_profile=browser_profile,
            storage_state=profile / "storage_state.json",
        )

    def resolve_existing_profile(self, credential: CredentialRef) -> ZLibraryProfilePaths:
        self._validate_credential(credential)
        profile = self._root / self.provider / "profiles" / self.profile_key(credential.profile)
        browser_profile = profile / "browser_profile"
        try:
            self._validate_directory(profile)
            self._validate_directory(browser_profile)
        except UnsafePathError:
            raise
        except OSError as exc:
            raise _auth_required("Z-Library profile is not logged in") from exc
        paths = ZLibraryProfilePaths(
            profile_directory=profile,
            browser_profile=browser_profile,
            storage_state=profile / "storage_state.json",
        )
        self.validate_profile_tree(paths)
        if paths.storage_state.exists() or paths.storage_state.is_symlink():
            self._validate_storage_state(paths.storage_state)
        return paths

    def create_migration_staging(self) -> ZLibraryProfilePaths:
        provider_root = self._ensure_private_directory(self._root / self.provider)
        staging_root = self._ensure_private_directory(provider_root / ".migration-staging")
        profile = Path(tempfile.mkdtemp(dir=staging_root, prefix="profile-"))
        if os.name != "nt":
            profile.chmod(0o700)
        browser_profile = self._ensure_private_directory(profile / "browser_profile")
        return ZLibraryProfilePaths(
            profile_directory=profile,
            browser_profile=browser_profile,
            storage_state=profile / "storage_state.json",
        )

    def publish_migration(
        self,
        staged: ZLibraryProfilePaths,
        credential: CredentialRef,
    ) -> ZLibraryProfilePaths:
        self._validate_credential(credential)
        self.validate_profile_tree(staged)
        staging_root = self._root / self.provider / ".migration-staging"
        if staging_root not in staged.profile_directory.parents:
            raise UnsafePathError("Z-Library migration staging escaped its managed root")
        provider_root = self._ensure_private_directory(self._root / self.provider)
        profiles_root = self._ensure_private_directory(provider_root / "profiles")
        target = profiles_root / self.profile_key(credential.profile)
        if target.exists() or target.is_symlink():
            raise FileExistsError("Z-Library credential profile already exists")
        os.rename(staged.profile_directory, target)
        return ZLibraryProfilePaths(
            profile_directory=target,
            browser_profile=target / "browser_profile",
            storage_state=target / "storage_state.json",
        )

    def discard_migration_staging(self, staged: ZLibraryProfilePaths) -> None:
        staging_root = self._root / self.provider / ".migration-staging"
        if staging_root not in staged.profile_directory.parents:
            raise UnsafePathError("Z-Library migration staging escaped its managed root")
        if staged.profile_directory.exists() or staged.profile_directory.is_symlink():
            metadata = staged.profile_directory.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
                raise UnsafePathError("Z-Library migration staging must be a private directory")
            self._validate_owner(metadata)
            shutil.rmtree(staged.profile_directory)

    def profile_exists(self, credential: CredentialRef) -> bool:
        self._validate_credential(credential)
        profile = self._root / self.provider / "profiles" / self.profile_key(credential.profile)
        try:
            metadata = profile.lstat()
        except FileNotFoundError:
            return False
        self._validate_directory_metadata(metadata)
        self._assert_confined(profile)
        return True

    def secure_profile_tree(self, paths: ZLibraryProfilePaths) -> None:
        self._assert_confined(paths.profile_directory)
        for directory, directory_names, filenames in os.walk(
            paths.profile_directory,
            topdown=True,
            followlinks=False,
        ):
            directory_path = Path(directory)
            self._validate_directory_type_and_owner(directory_path)
            if os.name != "nt":
                directory_path.chmod(0o700)
            for name in (*directory_names, *filenames):
                candidate = directory_path / name
                metadata = candidate.lstat()
                if stat.S_ISLNK(metadata.st_mode):
                    raise UnsafePathError("Z-Library profile cannot contain symbolic links")
                self._validate_owner(metadata)
                if stat.S_ISDIR(metadata.st_mode):
                    if os.name != "nt":
                        candidate.chmod(0o700)
                elif stat.S_ISREG(metadata.st_mode):
                    if os.name != "nt":
                        candidate.chmod(0o600)
                else:
                    raise UnsafePathError(
                        "Z-Library profile can contain only files and directories"
                    )
        self.validate_profile_tree(paths)
        if paths.storage_state.exists():
            self._validate_storage_state(paths.storage_state)

    def validate_profile_tree(self, paths: ZLibraryProfilePaths) -> None:
        self._assert_confined(paths.profile_directory)
        for directory, directory_names, filenames in os.walk(
            paths.profile_directory,
            topdown=True,
            followlinks=False,
        ):
            directory_path = Path(directory)
            self._validate_directory(directory_path)
            for name in (*directory_names, *filenames):
                candidate = directory_path / name
                metadata = candidate.lstat()
                if stat.S_ISLNK(metadata.st_mode):
                    raise UnsafePathError("Z-Library profile cannot contain symbolic links")
                if stat.S_ISDIR(metadata.st_mode):
                    self._validate_directory_metadata(metadata)
                elif stat.S_ISREG(metadata.st_mode):
                    self._validate_file_metadata(metadata)
                else:
                    raise UnsafePathError(
                        "Z-Library profile can contain only files and directories"
                    )

    def delete_profile(self, credential: CredentialRef) -> bool:
        if not self.profile_exists(credential):
            return False
        profile = self._root / self.provider / "profiles" / self.profile_key(credential.profile)
        paths = ZLibraryProfilePaths(
            profile_directory=profile,
            browser_profile=profile / "browser_profile",
            storage_state=profile / "storage_state.json",
        )
        self.validate_profile_tree(paths)
        shutil.rmtree(paths.profile_directory)
        return True

    @staticmethod
    def profile_key(profile: str) -> str:
        return f"profile-{hashlib.sha256(profile.encode()).hexdigest()[:32]}"

    def _prepare_root(self) -> None:
        self._reject_symlink_components(self._root)
        if not self._root.exists():
            self._root.mkdir(parents=True, mode=0o700)
            if os.name != "nt":
                self._root.chmod(0o700)
        self._validate_directory(self._root)

    def _ensure_private_directory(self, path: Path) -> Path:
        self._assert_confined(path)
        if not path.exists() and not path.is_symlink():
            path.mkdir(mode=0o700)
            if os.name != "nt":
                path.chmod(0o700)
        self._validate_directory(path)
        return path

    def _assert_confined(self, path: Path) -> None:
        absolute = Path(os.path.abspath(path))
        if absolute != self._root and self._root not in absolute.parents:
            raise UnsafePathError("Z-Library profile escaped the managed credential root")

    @classmethod
    def _validate_credential(cls, credential: CredentialRef) -> None:
        if credential.provider != cls.provider:
            raise ValueError(
                f"Z-Library credential resolver cannot use provider {credential.provider}"
            )

    @staticmethod
    def _validate_storage_state(path: Path) -> None:
        metadata = path.lstat()
        ZLibraryCredentialResolver._validate_file_metadata(metadata)
        if metadata.st_size <= 0 or metadata.st_size > _MAX_STORAGE_STATE_BYTES:
            raise _auth_required("Z-Library storage-state snapshot is invalid")
        flags = os.O_RDONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(path, flags)
        try:
            opened = os.fstat(descriptor)
            current = path.lstat()
            ZLibraryCredentialResolver._validate_file_metadata(opened)
            ZLibraryCredentialResolver._validate_file_metadata(current)
            if not os.path.samestat(opened, current):
                raise UnsafePathError("Z-Library storage-state snapshot changed while opening")
            with os.fdopen(descriptor, "rb", closefd=False) as raw:
                parsed = cast(object, json.load(cast(BinaryIO, raw)))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise _auth_required("Z-Library storage-state snapshot is invalid") from exc
        finally:
            os.close(descriptor)
        if not isinstance(parsed, dict) or not isinstance(parsed.get("cookies"), list):
            raise _auth_required("Z-Library storage-state snapshot is invalid")

    @staticmethod
    def _validate_directory(path: Path) -> None:
        try:
            metadata = path.lstat()
        except FileNotFoundError as exc:
            raise _auth_required("Z-Library profile is not logged in") from exc
        ZLibraryCredentialResolver._validate_directory_metadata(metadata)

    @staticmethod
    def _validate_directory_type_and_owner(path: Path) -> None:
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise UnsafePathError("Z-Library profile directory must not be a symbolic link")
        ZLibraryCredentialResolver._validate_owner(metadata)

    @staticmethod
    def _validate_directory_metadata(metadata: os.stat_result) -> None:
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise UnsafePathError("Z-Library profile directory must not be a symbolic link")
        ZLibraryCredentialResolver._validate_owner(metadata)
        if os.name != "nt" and stat.S_IMODE(metadata.st_mode) & 0o077:
            raise UnsafePathError("Z-Library profile directory permissions must be private (0700)")

    @staticmethod
    def _validate_file_metadata(metadata: os.stat_result) -> None:
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise UnsafePathError("Z-Library profile file must be a regular non-symlink file")
        ZLibraryCredentialResolver._validate_owner(metadata)
        if os.name != "nt" and stat.S_IMODE(metadata.st_mode) & 0o077:
            raise UnsafePathError("Z-Library profile file permissions must be private (0600)")

    @staticmethod
    def _validate_owner(metadata: os.stat_result) -> None:
        if os.name != "nt" and hasattr(os, "getuid") and metadata.st_uid != os.getuid():
            raise UnsafePathError("Z-Library profile must be owned by the current user")

    @staticmethod
    def _reject_symlink_components(path: Path) -> None:
        current = Path(path.anchor)
        for segment in path.parts[1:]:
            current /= segment
            if current.is_symlink():
                raise UnsafePathError("Z-Library credential path cannot contain symbolic links")


def _auth_required(message: str) -> DiandianError:
    return DiandianError(ErrorCode.AUTH_REQUIRED, message, retryable=False)
