"""Local install-token, bootstrap, browser-session, and CSRF security state."""

from __future__ import annotations

import base64
import fcntl
import hashlib
import hmac
import json
import math
import os
import secrets
import sqlite3
import stat
import threading
from collections.abc import Callable, Generator
from contextlib import contextmanager, suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from pathlib import Path
from typing import ClassVar, Final, cast
from uuid import uuid4

from diandianreading.domain import UnsafePathError
from diandianreading.infrastructure.persistence import SQLiteDatabase

INSTALL_TOKEN_FILENAME: Final = "install-token.json"
_INSTALL_TOKEN_VERSION: Final = 1
_SECRET_BYTES: Final = 32
_MAX_INSTALL_TOKEN_BYTES: Final = 4 * 1024
_MAX_PRESENTED_SECRET_BYTES: Final = 4 * 1024
_MAX_BOOTSTRAP_TTL: Final = timedelta(minutes=5)
_MAX_SQLITE_INTEGER: Final = (1 << 63) - 1
_DIGEST_HEX_LENGTH: Final = 64

_BOOTSTRAP_DOMAIN: Final = b"diandianreading.local-api.bootstrap.v1\x00"
_SESSION_DOMAIN: Final = b"diandianreading.local-api.session.v1\x00"
_CSRF_DOMAIN: Final = b"diandianreading.local-api.csrf.v1\x00"
_DUMMY_BOOTSTRAP_DIGEST: Final = hashlib.sha256(_BOOTSTRAP_DOMAIN).hexdigest()
_DUMMY_SESSION_DIGEST: Final = hashlib.sha256(_SESSION_DOMAIN).hexdigest()
_DUMMY_CSRF_DIGEST: Final = hashlib.sha256(_CSRF_DOMAIN).hexdigest()


class LocalApiSecurityError(RuntimeError):
    """Base class whose text is safe to surface through an API error mapper."""

    safe_message: ClassVar[str] = "Local API security operation failed"

    def __init__(self) -> None:
        super().__init__(self.safe_message)


class InstallTokenStoreError(LocalApiSecurityError):
    safe_message: ClassVar[str] = "Install token is unavailable"


class InstallTokenNotInitializedError(InstallTokenStoreError):
    """Raised when normal operation finds no initialized token file."""


class InvalidInstallTokenFileError(InstallTokenStoreError):
    """Raised for malformed, truncated, oversized, or unsupported token data."""


class UnsafeInstallTokenStoreError(InstallTokenStoreError):
    """Raised when credential filesystem ownership, mode, or type is unsafe."""


class InstallTokenAuthenticationError(LocalApiSecurityError):
    safe_message: ClassVar[str] = "Authentication failed"


class BootstrapAuthenticationError(LocalApiSecurityError):
    safe_message: ClassVar[str] = "Bootstrap credential is invalid"


class SessionAuthenticationError(LocalApiSecurityError):
    safe_message: ClassVar[str] = "Session is invalid"


class CsrfValidationError(LocalApiSecurityError):
    safe_message: ClassVar[str] = "CSRF validation failed"


class LocalApiSecurityCapacityError(LocalApiSecurityError):
    safe_message: ClassVar[str] = "Local API security capacity is unavailable"


class LocalApiSecurityStateError(LocalApiSecurityError):
    safe_message: ClassVar[str] = "Local API security state is unavailable"


class LocalApiSecurityConfigurationError(ValueError):
    """A static-message configuration failure that cannot include a secret or path."""

    def __init__(self) -> None:
        super().__init__("Local API security configuration is invalid")


@dataclass(frozen=True, slots=True)
class InstallTokenSecret:
    """The only explicit plaintext install-token carrier."""

    generation: int
    token: str = field(repr=False)


@dataclass(frozen=True, slots=True)
class VerifiedInstallToken:
    """A bearer identity that contains no plaintext credential."""

    generation: int


@dataclass(frozen=True, slots=True)
class BootstrapNonce:
    """A short-lived one-time bootstrap credential returned to a trusted launcher."""

    nonce: str = field(repr=False)
    install_token_generation: int
    expires_at: datetime

    @property
    def value(self) -> str:
        return self.nonce


@dataclass(frozen=True, slots=True)
class BrowserSessionCredentials:
    """Plaintext browser credentials returned exactly once after bootstrap."""

    session_token: str = field(repr=False)
    csrf_token: str = field(repr=False)
    idle_expires_at: datetime
    absolute_expires_at: datetime

    @property
    def session_cookie(self) -> str:
        return self.session_token


@dataclass(frozen=True, slots=True)
class AuthenticatedSession:
    """Non-secret local identity for an authenticated browser session."""

    session_id: str
    install_token_generation: int
    idle_expires_at: datetime
    absolute_expires_at: datetime

    @property
    def id(self) -> str:
        return self.session_id

    @property
    def generation(self) -> int:
        return self.install_token_generation


@dataclass(frozen=True, slots=True)
class CleanupResult:
    bootstrap_nonces_deleted: int
    browser_sessions_deleted: int


@dataclass(frozen=True, slots=True)
class LocalApiSecurityConfig:
    bootstrap_ttl: timedelta = timedelta(minutes=2)
    idle_ttl: timedelta = timedelta(minutes=30)
    absolute_ttl: timedelta = timedelta(hours=8)
    nonce_retention: timedelta = timedelta(minutes=10)
    session_retention: timedelta = timedelta(days=1)
    max_nonce_rows: int = 2_048
    max_session_rows: int = 4_096
    cleanup_limit: int = 256

    def __post_init__(self) -> None:
        for duration in (
            self.bootstrap_ttl,
            self.idle_ttl,
            self.absolute_ttl,
            self.nonce_retention,
            self.session_retention,
        ):
            _require_positive_duration(duration)
        if self.bootstrap_ttl > _MAX_BOOTSTRAP_TTL or self.idle_ttl > self.absolute_ttl:
            raise LocalApiSecurityConfigurationError
        for limit in (self.max_nonce_rows, self.max_session_rows, self.cleanup_limit):
            if type(limit) is not int or limit <= 0 or limit > _MAX_SQLITE_INTEGER:
                raise LocalApiSecurityConfigurationError


class SessionRevocationReason(StrEnum):
    LOGOUT = "logout"
    INSTALL_TOKEN_ROTATED = "install_token_rotated"
    SECURITY_RECOVERY = "security_recovery"
    APP_RESET = "app_reset"
    APPLICATION_RESET = "app_reset"


@dataclass(frozen=True, slots=True)
class _SessionState:
    session_id: str
    install_token_generation: int
    idle_expires_at: datetime
    absolute_expires_at: datetime
    version: int


class InstallTokenStore:
    """Own the private, atomic, versioned per-installation bearer token file."""

    def __init__(self, credential_root: Path) -> None:
        self._root: Path = Path(os.path.abspath(credential_root.expanduser()))
        self._path: Path = self._root / INSTALL_TOKEN_FILENAME
        self._thread_lock: threading.RLock = threading.RLock()
        self._prepare_root()

    @property
    def path(self) -> Path:
        return self._path

    def ensure_initial(self) -> InstallTokenSecret:
        """Explicitly create generation one, or return the already-valid token."""

        with self._locked_root() as root_descriptor:
            try:
                return self._read_locked(root_descriptor)
            except InstallTokenNotInitializedError:
                token = InstallTokenSecret(generation=1, token=_new_secret())
                self._atomic_write_locked(root_descriptor, token, require_absent=True)
                return token

    def rotate(self) -> InstallTokenSecret:
        """Atomically replace the token, deriving the next generation from disk."""

        with self._locked_root() as root_descriptor:
            current = self._read_locked(root_descriptor)
            if current.generation >= _MAX_SQLITE_INTEGER:
                raise InstallTokenStoreError
            rotated = InstallTokenSecret(
                generation=current.generation + 1,
                token=_new_secret(),
            )
            self._atomic_write_locked(root_descriptor, rotated, require_absent=False)
            return rotated

    def current_generation(self) -> int:
        with self._locked_root() as root_descriptor:
            return self._read_locked(root_descriptor).generation

    def verify_bearer(self, presented_token: str) -> VerifiedInstallToken:
        """Verify one raw Bearer credential using a constant-time comparison."""

        with self._locked_root() as root_descriptor:
            current = self._read_locked(root_descriptor)
        presented, valid = _bounded_secret_bytes(presented_token)
        expected = current.token.encode("ascii")
        comparison_value = presented if valid else bytes(len(expected))
        matches = hmac.compare_digest(expected, comparison_value)
        if not valid or not matches:
            raise InstallTokenAuthenticationError
        return VerifiedInstallToken(generation=current.generation)

    def verify_authorization_header(self, authorization: str | None) -> VerifiedInstallToken:
        if not isinstance(authorization, str):
            raise InstallTokenAuthenticationError
        scheme, separator, token = authorization.partition(" ")
        if (
            separator != " "
            or scheme.casefold() != "bearer"
            or not token
            or token.strip() != token
            or " " in token
        ):
            raise InstallTokenAuthenticationError
        return self.verify_bearer(token)

    def read_for_cli(self) -> InstallTokenSecret:
        """Explicitly return plaintext only for trusted future CLI composition."""

        with self._locked_root() as root_descriptor:
            return self._read_locked(root_descriptor)

    def _prepare_root(self) -> None:
        try:
            self._reject_symlink_components()
            created = False
            try:
                _ = self._root.lstat()
            except FileNotFoundError:
                try:
                    self._root.mkdir(parents=True, mode=0o700)
                    created = True
                except FileExistsError:
                    created = False
            if created and os.name != "nt":
                self._root.chmod(0o700)
            self._validate_root_metadata(self._root.lstat())
        except InstallTokenStoreError:
            raise
        except OSError:
            raise UnsafeInstallTokenStoreError from None

    @contextmanager
    def _locked_root(self) -> Generator[int, None, None]:
        with self._thread_lock:
            descriptor = -1
            locked = False
            try:
                self._reject_symlink_components()
                self._validate_root_metadata(self._root.lstat())
                flags = os.O_RDONLY
                if hasattr(os, "O_DIRECTORY"):
                    flags |= os.O_DIRECTORY
                if hasattr(os, "O_NOFOLLOW"):
                    flags |= os.O_NOFOLLOW
                descriptor = os.open(self._root, flags)
                opened = os.fstat(descriptor)
                current = self._root.lstat()
                self._validate_root_metadata(opened)
                self._validate_root_metadata(current)
                if not os.path.samestat(opened, current):
                    raise UnsafeInstallTokenStoreError
                fcntl.flock(descriptor, fcntl.LOCK_EX)
                locked = True
                current = self._root.lstat()
                self._validate_root_metadata(current)
                if not os.path.samestat(opened, current):
                    raise UnsafeInstallTokenStoreError
                yield descriptor
            except InstallTokenStoreError:
                raise
            except OSError:
                raise UnsafeInstallTokenStoreError from None
            finally:
                if descriptor >= 0:
                    if locked:
                        with suppress(OSError):
                            fcntl.flock(descriptor, fcntl.LOCK_UN)
                    os.close(descriptor)

    def _read_locked(self, root_descriptor: int) -> InstallTokenSecret:
        try:
            path_metadata = self._path.lstat()
        except FileNotFoundError:
            raise InstallTokenNotInitializedError from None
        except OSError:
            raise UnsafeInstallTokenStoreError from None
        self._validate_file_metadata(path_metadata)

        flags = os.O_RDONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(INSTALL_TOKEN_FILENAME, flags, dir_fd=root_descriptor)
        except FileNotFoundError:
            raise InstallTokenNotInitializedError from None
        except OSError:
            raise UnsafeInstallTokenStoreError from None

        try:
            opened_before = os.fstat(descriptor)
            current_before = self._path.lstat()
            self._validate_file_metadata(opened_before)
            self._validate_file_metadata(current_before)
            if not os.path.samestat(opened_before, current_before):
                raise UnsafeInstallTokenStoreError
            if opened_before.st_size <= 0 or opened_before.st_size > _MAX_INSTALL_TOKEN_BYTES:
                raise InvalidInstallTokenFileError
            payload = _read_bounded(descriptor, _MAX_INSTALL_TOKEN_BYTES)
            opened_after = os.fstat(descriptor)
            current_after = self._path.lstat()
            self._validate_file_metadata(opened_after)
            self._validate_file_metadata(current_after)
            if (
                not os.path.samestat(opened_after, current_after)
                or not _metadata_stable(opened_before, opened_after)
                or len(payload) != opened_after.st_size
            ):
                raise UnsafeInstallTokenStoreError
        except InstallTokenStoreError:
            raise
        except OSError:
            raise UnsafeInstallTokenStoreError from None
        finally:
            os.close(descriptor)
        return _parse_install_token(payload)

    def _atomic_write_locked(
        self,
        root_descriptor: int,
        token: InstallTokenSecret,
        *,
        require_absent: bool,
    ) -> None:
        payload = _serialize_install_token(token)
        temporary_name = f".{INSTALL_TOKEN_FILENAME}.{secrets.token_hex(16)}.tmp"
        temporary_descriptor = -1
        published = False
        try:
            if require_absent and self._target_exists():
                raise InstallTokenStoreError
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            temporary_descriptor = os.open(
                temporary_name,
                flags,
                0o600,
                dir_fd=root_descriptor,
            )
            if hasattr(os, "fchmod"):
                os.fchmod(temporary_descriptor, 0o600)
            _write_all(temporary_descriptor, payload)
            os.fsync(temporary_descriptor)
            self._validate_file_metadata(os.fstat(temporary_descriptor))
            os.close(temporary_descriptor)
            temporary_descriptor = -1
            if require_absent and self._target_exists():
                raise InstallTokenStoreError
            os.replace(
                temporary_name,
                INSTALL_TOKEN_FILENAME,
                src_dir_fd=root_descriptor,
                dst_dir_fd=root_descriptor,
            )
            published = True
            os.fsync(root_descriptor)
            written = self._read_locked(root_descriptor)
            if written != token:
                raise InstallTokenStoreError
        except InstallTokenStoreError:
            raise
        except OSError:
            raise InstallTokenStoreError from None
        finally:
            if temporary_descriptor >= 0:
                os.close(temporary_descriptor)
            if not published:
                try:
                    os.unlink(temporary_name, dir_fd=root_descriptor)
                except FileNotFoundError:
                    pass
                except OSError:
                    pass

    def _target_exists(self) -> bool:
        try:
            metadata = self._path.lstat()
        except FileNotFoundError:
            return False
        self._validate_file_metadata(metadata)
        return True

    def _reject_symlink_components(self) -> None:
        current = Path(self._root.anchor)
        for segment in self._root.parts[1:]:
            current /= segment
            try:
                metadata = current.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(metadata.st_mode):
                raise UnsafeInstallTokenStoreError

    @staticmethod
    def _validate_root_metadata(metadata: os.stat_result) -> None:
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise UnsafeInstallTokenStoreError
        _validate_owner(metadata)
        if os.name != "nt" and stat.S_IMODE(metadata.st_mode) != 0o700:
            raise UnsafeInstallTokenStoreError

    @staticmethod
    def _validate_file_metadata(metadata: os.stat_result) -> None:
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise UnsafeInstallTokenStoreError
        _validate_owner(metadata)
        if os.name != "nt" and stat.S_IMODE(metadata.st_mode) != 0o600:
            raise UnsafeInstallTokenStoreError


class LocalApiSecurityService:
    """Persist and validate bootstrap, browser-session, and CSRF security state."""

    def __init__(
        self,
        database: SQLiteDatabase,
        install_token_store: InstallTokenStore,
        *,
        config: LocalApiSecurityConfig | None = None,
        clock: Callable[[], datetime] | None = None,
        id_factory: Callable[[], str] | None = None,
    ) -> None:
        self._database: SQLiteDatabase = database
        self._install_tokens: InstallTokenStore = install_token_store
        self._config: LocalApiSecurityConfig = config or LocalApiSecurityConfig()
        self._clock: Callable[[], datetime] = clock or _system_utc_now
        self._id_factory: Callable[[], str] = id_factory or _new_id

    def authenticate_bearer(self, authorization: str | None) -> VerifiedInstallToken:
        """Verify an automation credential without exposing the install token."""

        return self._install_tokens.verify_authorization_header(authorization)

    def issue_bootstrap(self, ttl: timedelta | None = None) -> BootstrapNonce:
        effective_ttl = ttl if ttl is not None else self._config.bootstrap_ttl
        _require_positive_duration(effective_ttl)
        if effective_ttl > _MAX_BOOTSTRAP_TTL:
            raise LocalApiSecurityConfigurationError

        now = self._now()
        expires_at = _add_duration(now, effective_ttl)
        generation = self._install_tokens.current_generation()
        nonce = _new_secret()
        nonce_digest = _digest(_BOOTSTRAP_DOMAIN, nonce)
        nonce_id = self._next_id()

        with self._connect(immediate=True) as connection:
            _ = self._cleanup_nonces(connection, now, self._config.cleanup_limit)
            nonce_count = self._row_count(connection, "browser_bootstrap_nonces")
            if nonce_count >= self._config.max_nonce_rows:
                raise LocalApiSecurityCapacityError
            _ = connection.execute(
                """
                INSERT INTO browser_bootstrap_nonces(
                    id, nonce_digest, install_token_generation,
                    created_at, expires_at, consumed_at, version
                ) VALUES (?, ?, ?, ?, ?, NULL, 0)
                """,
                (
                    nonce_id,
                    nonce_digest,
                    generation,
                    now.isoformat(),
                    expires_at.isoformat(),
                ),
            )
        return BootstrapNonce(
            nonce=nonce,
            install_token_generation=generation,
            expires_at=expires_at,
        )

    def consume_bootstrap(self, raw_nonce: str) -> BrowserSessionCredentials:
        now = self._now()
        generation = self._install_tokens.current_generation()
        presented_digest, presented_valid = _presented_digest(_BOOTSTRAP_DOMAIN, raw_nonce)

        with self._connect(immediate=True) as connection:
            _ = self._cleanup_sessions(connection, now, self._config.cleanup_limit)
            row = _fetchone(
                connection.execute(
                    """
                    SELECT id, nonce_digest, install_token_generation, expires_at,
                           consumed_at, version
                    FROM browser_bootstrap_nonces
                    WHERE nonce_digest = ?
                    """,
                    (presented_digest,),
                )
            )
            stored_digest = (
                _digest_from_row(row, "nonce_digest")
                if row is not None
                else _DUMMY_BOOTSTRAP_DIGEST
            )
            digest_matches = hmac.compare_digest(presented_digest, stored_digest)
            if row is None or not presented_valid or not digest_matches:
                raise BootstrapAuthenticationError

            nonce_generation = _int_from_row(row, "install_token_generation")
            expires_at = _datetime_from_row(row, "expires_at")
            consumed_at = _object_from_row(row, "consumed_at")
            version = _version_from_row(row)
            nonce_id = _identifier_from_row(row, "id")
            if consumed_at is not None or expires_at <= now or nonce_generation != generation:
                raise BootstrapAuthenticationError
            session_count = self._row_count(connection, "browser_sessions")
            if session_count >= self._config.max_session_rows:
                raise LocalApiSecurityCapacityError

            session_token = _new_secret()
            csrf_token = _new_secret()
            absolute_expires_at = _add_duration(now, self._config.absolute_ttl)
            idle_expires_at = min(
                _add_duration(now, self._config.idle_ttl),
                absolute_expires_at,
            )
            session_id = self._next_id()
            consumed = connection.execute(
                """
                UPDATE browser_bootstrap_nonces
                SET consumed_at = ?, version = version + 1
                WHERE id = ? AND version = ? AND consumed_at IS NULL
                """,
                (now.isoformat(), nonce_id, version),
            )
            if consumed.rowcount != 1:
                raise BootstrapAuthenticationError
            _ = connection.execute(
                """
                INSERT INTO browser_sessions(
                    id, session_token_digest, csrf_token_digest,
                    install_token_generation, created_at, last_seen_at,
                    idle_expires_at, absolute_expires_at,
                    revoked_at, revoked_reason, version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)
                """,
                (
                    session_id,
                    _digest(_SESSION_DOMAIN, session_token),
                    _digest(_CSRF_DOMAIN, csrf_token),
                    generation,
                    now.isoformat(),
                    now.isoformat(),
                    idle_expires_at.isoformat(),
                    absolute_expires_at.isoformat(),
                ),
            )

        if self._install_tokens.current_generation() != generation:
            raise BootstrapAuthenticationError
        return BrowserSessionCredentials(
            session_token=session_token,
            csrf_token=csrf_token,
            idle_expires_at=idle_expires_at,
            absolute_expires_at=absolute_expires_at,
        )

    def authenticate_session(self, raw_session_token: str) -> AuthenticatedSession:
        now = self._now()
        generation = self._install_tokens.current_generation()
        presented_digest, presented_valid = _presented_digest(
            _SESSION_DOMAIN,
            raw_session_token,
        )

        with self._connect(immediate=True) as connection:
            row = _fetchone(
                connection.execute(
                    """
                    SELECT id, session_token_digest, install_token_generation,
                           idle_expires_at, absolute_expires_at, revoked_at, version
                    FROM browser_sessions
                    WHERE session_token_digest = ?
                    """,
                    (presented_digest,),
                )
            )
            stored_digest = (
                _digest_from_row(row, "session_token_digest")
                if row is not None
                else _DUMMY_SESSION_DIGEST
            )
            digest_matches = hmac.compare_digest(presented_digest, stored_digest)
            if row is None or not presented_valid or not digest_matches:
                raise SessionAuthenticationError
            state = _active_session_state(row, now, generation)
            if state is None:
                raise SessionAuthenticationError
            idle_expires_at = min(
                _add_duration(now, self._config.idle_ttl),
                state.absolute_expires_at,
            )
            updated = connection.execute(
                """
                UPDATE browser_sessions
                SET last_seen_at = ?, idle_expires_at = ?, version = version + 1
                WHERE id = ? AND version = ? AND revoked_at IS NULL
                """,
                (
                    now.isoformat(),
                    idle_expires_at.isoformat(),
                    state.session_id,
                    state.version,
                ),
            )
            if updated.rowcount != 1:
                raise SessionAuthenticationError

        if self._install_tokens.current_generation() != generation:
            raise SessionAuthenticationError
        return AuthenticatedSession(
            session_id=state.session_id,
            install_token_generation=state.install_token_generation,
            idle_expires_at=idle_expires_at,
            absolute_expires_at=state.absolute_expires_at,
        )

    def validate_csrf(
        self,
        session: AuthenticatedSession,
        raw_header: str | None,
        raw_cookie: str | None,
    ) -> None:
        now = self._now()
        generation = self._install_tokens.current_generation()
        with self._connect() as connection:
            row = _fetchone(
                connection.execute(
                    """
                    SELECT id, csrf_token_digest, install_token_generation,
                           idle_expires_at, absolute_expires_at, revoked_at, version
                    FROM browser_sessions
                    WHERE id = ?
                    """,
                    (session.session_id,),
                )
            )

        stored_digest = (
            _digest_from_row(row, "csrf_token_digest") if row is not None else _DUMMY_CSRF_DIGEST
        )
        state = _active_session_state(row, now, generation) if row is not None else None
        header_bytes, header_valid = _bounded_secret_bytes(raw_header)
        cookie_bytes, cookie_valid = _bounded_secret_bytes(raw_cookie)
        values_match = hmac.compare_digest(header_bytes, cookie_bytes)
        header_digest = hashlib.sha256(_CSRF_DOMAIN + header_bytes).hexdigest()
        digest_matches = hmac.compare_digest(header_digest, stored_digest)
        if (
            state is None
            or state.session_id != session.session_id
            or state.install_token_generation != session.install_token_generation
            or not header_valid
            or not cookie_valid
            or not values_match
            or not digest_matches
            or self._install_tokens.current_generation() != generation
        ):
            raise CsrfValidationError

    def revoke_session(
        self,
        session: AuthenticatedSession,
        *,
        reason: SessionRevocationReason | str = SessionRevocationReason.LOGOUT,
    ) -> bool:
        revocation_reason = _revocation_reason(reason)
        now = self._now()
        with self._connect(immediate=True) as connection:
            row = _fetchone(
                connection.execute(
                    """
                    SELECT id, install_token_generation, revoked_at, version
                    FROM browser_sessions
                    WHERE id = ?
                    """,
                    (session.session_id,),
                )
            )
            if row is None:
                return False
            if (
                _int_from_row(row, "install_token_generation") != session.install_token_generation
                or _object_from_row(row, "revoked_at") is not None
            ):
                return False
            version = _version_from_row(row)
            updated = connection.execute(
                """
                UPDATE browser_sessions
                SET revoked_at = ?, revoked_reason = ?, version = version + 1
                WHERE id = ? AND version = ? AND revoked_at IS NULL
                """,
                (
                    now.isoformat(),
                    revocation_reason.value,
                    session.session_id,
                    version,
                ),
            )
            return updated.rowcount == 1

    def revoke(
        self,
        session: AuthenticatedSession,
        *,
        reason: SessionRevocationReason | str = SessionRevocationReason.LOGOUT,
    ) -> bool:
        return self.revoke_session(session, reason=reason)

    def is_session_active(self, session: AuthenticatedSession) -> bool:
        """Recheck an SSE session without refreshing its idle expiration."""

        try:
            now = self._now()
            generation = self._install_tokens.current_generation()
            if session.install_token_generation != generation:
                return False
            with self._connect() as connection:
                row = _fetchone(
                    connection.execute(
                        """
                        SELECT id, install_token_generation, idle_expires_at,
                               absolute_expires_at, revoked_at, version
                        FROM browser_sessions
                        WHERE id = ?
                        """,
                        (session.session_id,),
                    )
                )
            state = _active_session_state(row, now, generation) if row is not None else None
            return (
                state is not None
                and state.session_id == session.session_id
                and self._install_tokens.current_generation() == generation
            )
        except (InstallTokenStoreError, LocalApiSecurityStateError):
            return False

    def cleanup(self, *, limit: int | None = None) -> CleanupResult:
        effective_limit = self._config.cleanup_limit if limit is None else limit
        if (
            type(effective_limit) is not int
            or effective_limit <= 0
            or effective_limit > self._config.cleanup_limit
        ):
            raise LocalApiSecurityConfigurationError
        now = self._now()
        with self._connect(immediate=True) as connection:
            nonces_deleted = self._cleanup_nonces(connection, now, effective_limit)
            sessions_deleted = self._cleanup_sessions(connection, now, effective_limit)
        return CleanupResult(
            bootstrap_nonces_deleted=nonces_deleted,
            browser_sessions_deleted=sessions_deleted,
        )

    def rotate_install_token(self) -> InstallTokenSecret:
        return self._install_tokens.rotate()

    def recover_after_install_token_loss(self) -> None:
        """Revoke every browser credential after a missing token file is recreated."""

        now = self._now().isoformat()
        with self._connect(immediate=True) as connection:
            connection.execute(
                """
                UPDATE browser_bootstrap_nonces
                SET consumed_at = COALESCE(consumed_at, ?)
                WHERE consumed_at IS NULL
                """,
                (now,),
            )
            connection.execute(
                """
                UPDATE browser_sessions
                SET revoked_at = COALESCE(revoked_at, ?),
                    revoked_reason = COALESCE(
                        revoked_reason, ?
                    ),
                    version = CASE WHEN revoked_at IS NULL THEN version + 1 ELSE version END
                WHERE revoked_at IS NULL
                """,
                (now, SessionRevocationReason.SECURITY_RECOVERY.value),
            )

    @contextmanager
    def _connect(self, *, immediate: bool = False) -> Generator[sqlite3.Connection, None, None]:
        try:
            with self._database.connect(immediate=immediate) as connection:
                yield connection
        except LocalApiSecurityError:
            raise
        except (sqlite3.Error, OSError, UnsafePathError):
            raise LocalApiSecurityStateError from None

    def _cleanup_nonces(
        self,
        connection: sqlite3.Connection,
        now: datetime,
        limit: int,
    ) -> int:
        cutoff = _subtract_duration(now, self._config.nonce_retention).isoformat()
        deleted = connection.execute(
            """
            DELETE FROM browser_bootstrap_nonces
            WHERE id IN (
                SELECT id
                FROM browser_bootstrap_nonces
                WHERE (consumed_at IS NOT NULL AND consumed_at <= ?)
                   OR (consumed_at IS NULL AND expires_at <= ?)
                ORDER BY COALESCE(consumed_at, expires_at), id
                LIMIT ?
            )
            """,
            (cutoff, cutoff, limit),
        )
        return _rowcount(deleted)

    def _cleanup_sessions(
        self,
        connection: sqlite3.Connection,
        now: datetime,
        limit: int,
    ) -> int:
        cutoff = _subtract_duration(now, self._config.session_retention).isoformat()
        deleted = connection.execute(
            """
            DELETE FROM browser_sessions
            WHERE id IN (
                SELECT id
                FROM browser_sessions
                WHERE (revoked_at IS NOT NULL AND revoked_at <= ?)
                   OR (
                       revoked_at IS NULL
                       AND (idle_expires_at <= ? OR absolute_expires_at <= ?)
                   )
                ORDER BY COALESCE(revoked_at, idle_expires_at), id
                LIMIT ?
            )
            """,
            (cutoff, cutoff, cutoff, limit),
        )
        return _rowcount(deleted)

    @staticmethod
    def _row_count(connection: sqlite3.Connection, table: str) -> int:
        if table not in {"browser_bootstrap_nonces", "browser_sessions"}:
            raise LocalApiSecurityStateError
        row = _fetchone(connection.execute(f"SELECT COUNT(*) AS row_count FROM {table}"))
        if row is None:
            raise LocalApiSecurityStateError
        count = _object_from_row(row, "row_count")
        if type(count) is not int or count < 0:
            raise LocalApiSecurityStateError
        return count

    def _now(self) -> datetime:
        try:
            return _as_utc(self._clock())
        except (TypeError, ValueError, OverflowError):
            raise LocalApiSecurityStateError from None

    def _next_id(self) -> str:
        value = cast(object, self._id_factory())
        if not isinstance(value, str) or not value or value.strip() != value or len(value) > 128:
            raise LocalApiSecurityStateError
        return value


def _new_secret() -> str:
    return secrets.token_urlsafe(_SECRET_BYTES)


def _new_id() -> str:
    return uuid4().hex


def _system_utc_now() -> datetime:
    return datetime.now(UTC)


def _require_positive_duration(value: object) -> None:
    if not isinstance(value, timedelta):
        raise LocalApiSecurityConfigurationError
    try:
        seconds = value.total_seconds()
    except OverflowError:
        raise LocalApiSecurityConfigurationError from None
    if not math.isfinite(seconds) or seconds <= 0:
        raise LocalApiSecurityConfigurationError


def _as_utc(value: object) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError
    return value.astimezone(UTC)


def _add_duration(value: datetime, duration: timedelta) -> datetime:
    try:
        return value + duration
    except OverflowError:
        raise LocalApiSecurityStateError from None


def _subtract_duration(value: datetime, duration: timedelta) -> datetime:
    try:
        return value - duration
    except OverflowError:
        raise LocalApiSecurityStateError from None


def _validate_owner(metadata: os.stat_result) -> None:
    if os.name != "nt" and hasattr(os, "getuid") and metadata.st_uid != os.getuid():
        raise UnsafeInstallTokenStoreError


def _new_token_has_sufficient_entropy(token: str) -> bool:
    try:
        encoded = token.encode("ascii")
        if not encoded or len(encoded) > _MAX_PRESENTED_SECRET_BYTES:
            return False
        padding = b"=" * ((4 - len(encoded) % 4) % 4)
        decoded = base64.b64decode(encoded + padding, altchars=b"-_", validate=True)
    except (UnicodeEncodeError, ValueError):
        return False
    return len(decoded) >= _SECRET_BYTES


def _serialize_install_token(token: InstallTokenSecret) -> bytes:
    if (
        type(token.generation) is not int
        or token.generation < 1
        or token.generation > _MAX_SQLITE_INTEGER
        or not _new_token_has_sufficient_entropy(token.token)
    ):
        raise InvalidInstallTokenFileError
    payload = json.dumps(
        {
            "version": _INSTALL_TOKEN_VERSION,
            "generation": token.generation,
            "token": token.token,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    if len(payload) > _MAX_INSTALL_TOKEN_BYTES:
        raise InvalidInstallTokenFileError
    return payload + b"\n"


def _parse_install_token(payload: bytes) -> InstallTokenSecret:
    try:
        parsed = cast(object, json.loads(payload.decode("utf-8")))
    except (UnicodeError, json.JSONDecodeError):
        raise InvalidInstallTokenFileError from None
    if not isinstance(parsed, dict):
        raise InvalidInstallTokenFileError
    untyped_document = cast(dict[object, object], parsed)
    if set(untyped_document) != {"version", "generation", "token"}:
        raise InvalidInstallTokenFileError
    document = cast(dict[str, object], untyped_document)
    version = document["version"]
    generation = document["generation"]
    token = document["token"]
    if (
        type(version) is not int
        or version != _INSTALL_TOKEN_VERSION
        or type(generation) is not int
        or generation < 1
        or generation > _MAX_SQLITE_INTEGER
        or not isinstance(token, str)
        or not _new_token_has_sufficient_entropy(token)
    ):
        raise InvalidInstallTokenFileError
    return InstallTokenSecret(generation=generation, token=token)


def _read_bounded(descriptor: int, limit: int) -> bytes:
    chunks: list[bytes] = []
    remaining = limit + 1
    while remaining > 0:
        chunk = os.read(descriptor, min(remaining, 1024))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    payload = b"".join(chunks)
    if len(payload) > limit:
        raise InvalidInstallTokenFileError
    return payload


def _write_all(descriptor: int, payload: bytes) -> None:
    remaining = memoryview(payload)
    while remaining:
        written = os.write(descriptor, remaining)
        if written <= 0:
            raise OSError
        remaining = remaining[written:]


def _metadata_stable(before: os.stat_result, after: os.stat_result) -> bool:
    return (
        os.path.samestat(before, after)
        and before.st_size == after.st_size
        and before.st_mtime_ns == after.st_mtime_ns
        and before.st_ctime_ns == after.st_ctime_ns
    )


def _bounded_secret_bytes(value: object) -> tuple[bytes, bool]:
    if not isinstance(value, str):
        return b"", False
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError:
        return b"", False
    if not encoded or len(encoded) > _MAX_PRESENTED_SECRET_BYTES:
        return b"", False
    return encoded, True


def _digest(domain: bytes, secret: str) -> str:
    encoded, valid = _bounded_secret_bytes(secret)
    if not valid:
        raise LocalApiSecurityStateError
    return hashlib.sha256(domain + encoded).hexdigest()


def _presented_digest(domain: bytes, secret: object) -> tuple[str, bool]:
    encoded, valid = _bounded_secret_bytes(secret)
    return hashlib.sha256(domain + encoded).hexdigest(), valid


def _fetchone(cursor: sqlite3.Cursor) -> sqlite3.Row | None:
    return cast(sqlite3.Row | None, cursor.fetchone())


def _object_from_row(row: sqlite3.Row, field_name: str) -> object:
    try:
        return cast(object, row[field_name])
    except (IndexError, KeyError):
        raise LocalApiSecurityStateError from None


def _identifier_from_row(row: sqlite3.Row, field_name: str) -> str:
    value = _object_from_row(row, field_name)
    if not isinstance(value, str) or not value or len(value) > 128:
        raise LocalApiSecurityStateError
    return value


def _int_from_row(row: sqlite3.Row, field_name: str) -> int:
    value = _object_from_row(row, field_name)
    if type(value) is not int:
        raise LocalApiSecurityStateError
    return value


def _version_from_row(row: sqlite3.Row) -> int:
    version = _int_from_row(row, "version")
    if version < 0 or version > _MAX_SQLITE_INTEGER:
        raise LocalApiSecurityStateError
    return version


def _digest_from_row(row: sqlite3.Row, field_name: str) -> str:
    value = _object_from_row(row, field_name)
    if (
        not isinstance(value, str)
        or len(value) != _DIGEST_HEX_LENGTH
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise LocalApiSecurityStateError
    return value


def _datetime_from_row(row: sqlite3.Row, field_name: str) -> datetime:
    value = _object_from_row(row, field_name)
    if not isinstance(value, str):
        raise LocalApiSecurityStateError
    try:
        return _as_utc(datetime.fromisoformat(value))
    except (TypeError, ValueError, OverflowError):
        raise LocalApiSecurityStateError from None


def _active_session_state(
    row: sqlite3.Row,
    now: datetime,
    current_generation: int,
) -> _SessionState | None:
    revoked_at = _object_from_row(row, "revoked_at")
    if revoked_at is not None:
        if not isinstance(revoked_at, str):
            raise LocalApiSecurityStateError
        try:
            _ = _as_utc(datetime.fromisoformat(revoked_at))
        except (TypeError, ValueError, OverflowError):
            raise LocalApiSecurityStateError from None
        return None
    generation = _int_from_row(row, "install_token_generation")
    idle_expires_at = _datetime_from_row(row, "idle_expires_at")
    absolute_expires_at = _datetime_from_row(row, "absolute_expires_at")
    if (
        generation != current_generation
        or idle_expires_at <= now
        or absolute_expires_at <= now
        or idle_expires_at > absolute_expires_at
    ):
        return None
    return _SessionState(
        session_id=_identifier_from_row(row, "id"),
        install_token_generation=generation,
        idle_expires_at=idle_expires_at,
        absolute_expires_at=absolute_expires_at,
        version=_version_from_row(row),
    )


def _rowcount(cursor: sqlite3.Cursor) -> int:
    if cursor.rowcount < 0:
        raise LocalApiSecurityStateError
    return cursor.rowcount


def _revocation_reason(value: SessionRevocationReason | str) -> SessionRevocationReason:
    if isinstance(value, SessionRevocationReason):
        return value
    try:
        return SessionRevocationReason(value)
    except (TypeError, ValueError):
        raise LocalApiSecurityConfigurationError from None
