"""Provider-isolated credential path resolution for NotebookLM profiles."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, ClassVar, cast

from diandianreading.domain import CredentialRef, DiandianError, ErrorCode, UnsafePathError

_MAX_STORAGE_STATE_BYTES = 16 * 1024 * 1024
_STORAGE_STATE_FILENAME = "storage_state.json"


@dataclass(frozen=True, slots=True)
class NotebookLMProfilePaths:
    """Infrastructure-only paths for one project-managed NotebookLM profile."""

    provider_root: Path
    profile_key: str
    profile_directory: Path
    browser_profile: Path
    storage_state: Path
    context: Path
    storage_context: Path
    master_token: Path


class CredentialPathResolver:
    """Map opaque profile references into one private NotebookLM credential root."""

    provider: ClassVar[str] = "notebooklm"

    def __init__(self, credentials_root: Path) -> None:
        self._root: Path = Path(os.path.abspath(credentials_root.expanduser()))
        self._prepare_root()

    @property
    def provider_root(self) -> Path:
        """Return the project-owned NotebookLM home without creating it."""

        return self._root / self.provider

    def profile_paths(self, credential: CredentialRef) -> NotebookLMProfilePaths:
        """Return the immutable path bundle for a logical profile without creating it."""

        self._validate_credential(credential)
        profile_key = self.profile_key(credential.profile)
        profile_directory = self.provider_root / "profiles" / profile_key
        storage_state = profile_directory / _STORAGE_STATE_FILENAME
        return NotebookLMProfilePaths(
            provider_root=self.provider_root,
            profile_key=profile_key,
            profile_directory=profile_directory,
            browser_profile=profile_directory / "browser_profile",
            storage_state=storage_state,
            context=profile_directory / "context.json",
            storage_context=storage_state.with_suffix(storage_state.suffix + ".context.json"),
            master_token=profile_directory / "master_token.json",
        )

    def prepare_profile(self, credential: CredentialRef) -> NotebookLMProfilePaths:
        """Create the complete private directory layout used by the NotebookLM CLI."""

        paths = self.profile_paths(credential)
        self._validate_base_root()
        _ = self._ensure_private_directory(paths.provider_root)
        _ = self._ensure_private_directory(paths.profile_directory.parent)
        _ = self._ensure_private_directory(paths.profile_directory)
        _ = self._ensure_private_directory(paths.browser_profile)
        return paths

    def prepare_profile_directory(self, credential: CredentialRef) -> Path:
        """Create and return the private profile directory used by an auth writer."""

        return self.prepare_profile(credential).profile_directory

    def profile_exists(self, credential: CredentialRef) -> bool:
        """Return whether the exact managed profile exists, rejecting unsafe metadata."""

        paths = self.profile_paths(credential)
        self._validate_base_root()
        if not self._private_directory_exists(paths.provider_root):
            return False
        if not self._private_directory_exists(paths.profile_directory.parent):
            return False
        try:
            metadata = paths.profile_directory.lstat()
        except FileNotFoundError:
            return False
        self._validate_directory_metadata(metadata)
        self._assert_confined(paths.profile_directory)
        return True

    def resolve_existing_profile(self, credential: CredentialRef) -> NotebookLMProfilePaths:
        """Return an existing profile after validating its complete local tree."""

        paths = self.profile_paths(credential)
        if not self.profile_exists(credential):
            raise _auth_required("NotebookLM profile is not logged in")
        self.validate_profile_tree(paths)
        return paths

    def resolve_storage_state(self, credential: CredentialRef) -> Path:
        """Return a validated storage-state path without exposing it to Application code."""

        paths = self.profile_paths(credential)
        if not self.profile_exists(credential):
            raise _auth_required("NotebookLM profile is not logged in")
        storage_state = paths.storage_state
        try:
            metadata = storage_state.lstat()
        except FileNotFoundError as exc:
            raise _auth_required("NotebookLM profile is not logged in") from exc
        self._validate_file_metadata(storage_state, metadata)
        self._validate_storage_state_content(storage_state)
        self.validate_profile_tree(paths)
        return storage_state

    def secure_profile_tree(self, paths: NotebookLMProfilePaths) -> None:
        """Normalize a vendor-written profile to private modes after validating its types."""

        entries = self._validated_tree_entries(paths, require_private_permissions=False)
        if os.name != "nt":
            for path, is_directory in entries:
                path.chmod(0o700 if is_directory else 0o600)
        self.validate_profile_tree(paths)

    def validate_profile_tree(self, paths: NotebookLMProfilePaths) -> None:
        """Validate confinement, ownership, modes, and entry types for a profile tree."""

        _ = self._validated_tree_entries(paths, require_private_permissions=True)

    def delete_profile(self, credential: CredentialRef) -> bool:
        """Delete only the complete project-managed local profile, without remote revocation."""

        paths = self.profile_paths(credential)
        if not self.profile_exists(credential):
            return False
        self.validate_profile_tree(paths)
        shutil.rmtree(paths.profile_directory)
        return True

    @staticmethod
    def profile_key(profile: str) -> str:
        """Return the stable, filesystem-safe key for a logical profile name."""

        digest = hashlib.sha256(profile.encode()).hexdigest()
        return f"profile-{digest[:32]}"

    @staticmethod
    def safe_profile_key(profile: str) -> str:
        """Compatibility alias that makes the safe-key intent explicit."""

        return CredentialPathResolver.profile_key(profile)

    @staticmethod
    def _profile_key(profile: str) -> str:
        """Preserve the original private hashing helper and its exact semantics."""

        return CredentialPathResolver.profile_key(profile)

    def _prepare_root(self) -> None:
        self._reject_symlink_components(self._root)
        if not self._root.exists():
            self._root.mkdir(parents=True, mode=0o700)
            if os.name != "nt":
                self._root.chmod(0o700)
        self._validate_directory(self._root)

    def _validate_base_root(self) -> None:
        self._reject_symlink_components(self._root)
        self._validate_directory(self._root)

    def _ensure_private_directory(self, path: Path) -> Path:
        self._assert_confined(path)
        created = False
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            try:
                path.mkdir(mode=0o700)
                created = True
            except FileExistsError:
                created = False
            metadata = path.lstat()
        self._validate_directory_metadata(metadata)
        if created and os.name != "nt":
            path.chmod(0o700)
        self._validate_directory(path)
        return path

    def _private_directory_exists(self, path: Path) -> bool:
        self._assert_confined(path)
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            return False
        self._validate_directory_metadata(metadata)
        return True

    def _validated_tree_entries(
        self,
        paths: NotebookLMProfilePaths,
        *,
        require_private_permissions: bool,
    ) -> list[tuple[Path, bool]]:
        self._validate_path_bundle(paths)
        self._validate_base_root()
        self._validate_directory(paths.provider_root)
        self._validate_directory(paths.profile_directory.parent)

        entries: list[tuple[Path, bool]] = []

        def raise_walk_error(error: OSError) -> None:
            raise error

        for directory, directory_names, filenames in os.walk(
            paths.profile_directory,
            topdown=True,
            onerror=raise_walk_error,
            followlinks=False,
        ):
            directory_path = Path(directory)
            directory_metadata = directory_path.lstat()
            self._validate_tree_entry(
                directory_metadata,
                require_private_permissions=require_private_permissions,
            )
            if not stat.S_ISDIR(directory_metadata.st_mode):
                raise UnsafePathError("NotebookLM profile directory must not be a symbolic link")
            entries.append((directory_path, True))
            for name in (*directory_names, *filenames):
                candidate = directory_path / name
                metadata = candidate.lstat()
                self._validate_tree_entry(
                    metadata,
                    require_private_permissions=require_private_permissions,
                )
                if stat.S_ISDIR(metadata.st_mode):
                    entries.append((candidate, True))
                elif stat.S_ISREG(metadata.st_mode):
                    entries.append((candidate, False))
                else:
                    raise UnsafePathError(
                        "NotebookLM profile can contain only regular files and directories"
                    )
        if not entries:
            raise UnsafePathError("NotebookLM credential directory does not exist")
        return entries

    def _validate_path_bundle(self, paths: NotebookLMProfilePaths) -> None:
        profile_key = paths.profile_key
        digest = profile_key.removeprefix("profile-")
        if (
            not profile_key.startswith("profile-")
            or len(digest) != 32
            or any(character not in "0123456789abcdef" for character in digest)
        ):
            raise UnsafePathError("NotebookLM profile key is not filesystem-safe")
        profile_directory = self.provider_root / "profiles" / profile_key
        storage_state = profile_directory / _STORAGE_STATE_FILENAME
        expected = NotebookLMProfilePaths(
            provider_root=self.provider_root,
            profile_key=profile_key,
            profile_directory=profile_directory,
            browser_profile=profile_directory / "browser_profile",
            storage_state=storage_state,
            context=profile_directory / "context.json",
            storage_context=storage_state.with_suffix(storage_state.suffix + ".context.json"),
            master_token=profile_directory / "master_token.json",
        )
        if paths != expected:
            raise UnsafePathError("NotebookLM profile paths escaped their managed layout")
        self._assert_confined(paths.profile_directory)

    def _assert_confined(self, path: Path) -> None:
        absolute = Path(os.path.abspath(path))
        if absolute != self._root and self._root not in absolute.parents:
            raise UnsafePathError("Credential profile escaped the managed credential root")

    @classmethod
    def _validate_credential(cls, credential: CredentialRef) -> None:
        if credential.provider != cls.provider:
            raise ValueError(
                f"NotebookLM credential resolver cannot use provider {credential.provider}"
            )

    @staticmethod
    def _validate_storage_state_content(path: Path) -> None:
        flags = os.O_RDONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(path, flags)
        try:
            opened_metadata = os.fstat(descriptor)
            current_metadata = path.lstat()
            CredentialPathResolver._validate_file_metadata(path, opened_metadata)
            CredentialPathResolver._validate_file_metadata(path, current_metadata)
            if not os.path.samestat(opened_metadata, current_metadata):
                raise UnsafePathError("NotebookLM credential changed while it was being opened")
            if opened_metadata.st_size <= 0 or opened_metadata.st_size > _MAX_STORAGE_STATE_BYTES:
                raise _auth_required("NotebookLM profile storage state is invalid")
            with os.fdopen(descriptor, "rb", closefd=False) as raw:
                parsed = cast(object, json.load(cast(BinaryIO, raw)))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise _auth_required("NotebookLM profile storage state is invalid") from exc
        finally:
            os.close(descriptor)
        if not isinstance(parsed, dict):
            raise _auth_required("NotebookLM profile storage state is invalid")
        storage_state = cast(dict[str, object], parsed)
        if not isinstance(storage_state.get("cookies"), list):
            raise _auth_required("NotebookLM profile storage state is invalid")

    @staticmethod
    def _validate_tree_entry(
        metadata: os.stat_result,
        *,
        require_private_permissions: bool,
    ) -> None:
        if stat.S_ISLNK(metadata.st_mode):
            raise UnsafePathError("NotebookLM profile cannot contain symbolic links")
        CredentialPathResolver._validate_owner(metadata)
        if stat.S_ISDIR(metadata.st_mode):
            if (
                require_private_permissions
                and os.name != "nt"
                and stat.S_IMODE(metadata.st_mode) & 0o077
            ):
                raise UnsafePathError(
                    "NotebookLM credential directory permissions must be private (0700)"
                )
            return
        if stat.S_ISREG(metadata.st_mode):
            if (
                require_private_permissions
                and os.name != "nt"
                and stat.S_IMODE(metadata.st_mode) & 0o077
            ):
                raise UnsafePathError("NotebookLM credential permissions must be private (0600)")
            return
        raise UnsafePathError("NotebookLM profile can contain only regular files and directories")

    @staticmethod
    def _validate_file_metadata(path: Path, metadata: os.stat_result) -> None:
        del path
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise UnsafePathError("NotebookLM credential must be a regular non-symlink file")
        CredentialPathResolver._validate_owner(metadata)
        if os.name != "nt" and stat.S_IMODE(metadata.st_mode) & 0o077:
            raise UnsafePathError("NotebookLM credential permissions must be private (0600)")

    @staticmethod
    def _validate_directory(path: Path) -> None:
        try:
            metadata = path.lstat()
        except FileNotFoundError as exc:
            raise UnsafePathError("NotebookLM credential directory does not exist") from exc
        CredentialPathResolver._validate_directory_metadata(metadata)

    @staticmethod
    def _validate_directory_metadata(metadata: os.stat_result) -> None:
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise UnsafePathError("NotebookLM credential directory must not be a symlink")
        CredentialPathResolver._validate_owner(metadata)
        if os.name != "nt" and stat.S_IMODE(metadata.st_mode) & 0o077:
            raise UnsafePathError(
                "NotebookLM credential directory permissions must be private (0700)"
            )

    @staticmethod
    def _validate_owner(metadata: os.stat_result) -> None:
        if os.name != "nt" and hasattr(os, "getuid") and metadata.st_uid != os.getuid():
            raise UnsafePathError("NotebookLM credential must be owned by the current user")

    @staticmethod
    def _reject_symlink_components(path: Path) -> None:
        current = Path(path.anchor)
        for segment in path.parts[1:]:
            current /= segment
            if current.is_symlink():
                raise UnsafePathError("NotebookLM credential path cannot contain symlinks")


def _auth_required(message: str) -> DiandianError:
    return DiandianError(ErrorCode.AUTH_REQUIRED, message, retryable=False)
