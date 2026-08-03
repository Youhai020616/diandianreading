"""Provider-isolated credential path resolution for NotebookLM profiles."""

from __future__ import annotations

import hashlib
import json
import os
import stat
from pathlib import Path
from typing import BinaryIO, cast

from diandianreading.domain import CredentialRef, DiandianError, ErrorCode, UnsafePathError

_MAX_STORAGE_STATE_BYTES = 16 * 1024 * 1024
_STORAGE_STATE_FILENAME = "storage_state.json"


class CredentialPathResolver:
    """Map opaque profile references into one private NotebookLM credential root."""

    provider = "notebooklm"

    def __init__(self, credentials_root: Path) -> None:
        self._root = Path(os.path.abspath(credentials_root.expanduser()))
        self._prepare_root()

    def prepare_profile_directory(self, credential: CredentialRef) -> Path:
        """Create and return the private profile directory used by an auth writer."""

        self._validate_credential(credential)
        provider_root = self._ensure_private_directory(self._root / self.provider)
        profiles_root = self._ensure_private_directory(provider_root / "profiles")
        return self._ensure_private_directory(profiles_root / self._profile_key(credential.profile))

    def resolve_storage_state(self, credential: CredentialRef) -> Path:
        """Return a validated storage-state path without exposing it to Application code."""

        profile_directory = self.prepare_profile_directory(credential)
        storage_state = profile_directory / _STORAGE_STATE_FILENAME
        try:
            metadata = storage_state.lstat()
        except FileNotFoundError as exc:
            raise _auth_required("NotebookLM profile is not logged in") from exc
        self._validate_file_metadata(storage_state, metadata)
        self._validate_storage_state_content(storage_state)
        return storage_state

    @staticmethod
    def _profile_key(profile: str) -> str:
        digest = hashlib.sha256(profile.encode()).hexdigest()
        return f"profile-{digest[:32]}"

    def _prepare_root(self) -> None:
        self._reject_symlink_components(self._root)
        if not self._root.exists():
            self._root.mkdir(parents=True, mode=0o700)
            if os.name != "nt":
                self._root.chmod(0o700)
        self._validate_directory(self._root)

    def _ensure_private_directory(self, path: Path) -> Path:
        if not path.exists() and not path.is_symlink():
            path.mkdir(mode=0o700)
            if os.name != "nt":
                path.chmod(0o700)
        self._validate_directory(path)
        if self._root != path and self._root not in path.parents:
            raise UnsafePathError("Credential profile escaped the managed credential root")
        return path

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
        if not isinstance(parsed, dict) or not isinstance(parsed.get("cookies"), list):
            raise _auth_required("NotebookLM profile storage state is invalid")

    @staticmethod
    def _validate_file_metadata(path: Path, metadata: os.stat_result) -> None:
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise UnsafePathError("NotebookLM credential must be a regular non-symlink file")
        if os.name != "nt":
            if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
                raise UnsafePathError("NotebookLM credential is not owned by the current user")
            if stat.S_IMODE(metadata.st_mode) & 0o077:
                raise UnsafePathError("NotebookLM credential permissions must be private (0600)")

    @staticmethod
    def _validate_directory(path: Path) -> None:
        try:
            metadata = path.lstat()
        except FileNotFoundError as exc:
            raise UnsafePathError("NotebookLM credential directory does not exist") from exc
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise UnsafePathError("NotebookLM credential directory must not be a symlink")
        if os.name != "nt":
            if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
                raise UnsafePathError(
                    "NotebookLM credential directory is not owned by the current user"
                )
            if stat.S_IMODE(metadata.st_mode) & 0o077:
                raise UnsafePathError(
                    "NotebookLM credential directory permissions must be private (0700)"
                )

    @staticmethod
    def _reject_symlink_components(path: Path) -> None:
        current = Path(path.anchor)
        for segment in path.parts[1:]:
            current /= segment
            if current.is_symlink():
                raise UnsafePathError("NotebookLM credential path cannot contain symlinks")


def _auth_required(message: str) -> DiandianError:
    return DiandianError(ErrorCode.AUTH_REQUIRED, message, retryable=False)
