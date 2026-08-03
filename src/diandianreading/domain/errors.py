"""Provider-neutral error categories used by domain and application layers."""

from __future__ import annotations

from enum import StrEnum


class ErrorCode(StrEnum):
    """Stable error codes safe to persist and expose through local APIs."""

    VALIDATION = "VALIDATION"
    AUTH_REQUIRED = "AUTH_REQUIRED"
    SOURCE_UNAVAILABLE = "SOURCE_UNAVAILABLE"
    DOWNLOAD_TIMEOUT = "DOWNLOAD_TIMEOUT"
    FORMAT_UNSUPPORTED = "FORMAT_UNSUPPORTED"
    CONVERSION_FAILED = "CONVERSION_FAILED"
    SOURCE_LIMIT_EXCEEDED = "SOURCE_LIMIT_EXCEEDED"
    REMOTE_RATE_LIMITED = "REMOTE_RATE_LIMITED"
    REMOTE_UNAVAILABLE = "REMOTE_UNAVAILABLE"
    REMOTE_PROTOCOL_DRIFT = "REMOTE_PROTOCOL_DRIFT"
    REMOTE_OUTCOME_AMBIGUOUS = "REMOTE_OUTCOME_AMBIGUOUS"
    SOURCE_PROCESSING_FAILED = "SOURCE_PROCESSING_FAILED"
    REPOSITORY_CONFLICT = "REPOSITORY_CONFLICT"
    CANCELLED = "CANCELLED"
    UNEXPECTED = "UNEXPECTED"


_RETRYABLE_CODES = frozenset(
    {
        ErrorCode.SOURCE_UNAVAILABLE,
        ErrorCode.DOWNLOAD_TIMEOUT,
        ErrorCode.REMOTE_RATE_LIMITED,
        ErrorCode.REMOTE_UNAVAILABLE,
        ErrorCode.SOURCE_PROCESSING_FAILED,
        ErrorCode.REPOSITORY_CONFLICT,
    }
)


def is_retryable_error(code: ErrorCode) -> bool:
    """Return whether a failed job may be retried without separate user action."""

    return code in _RETRYABLE_CODES


def safe_public_message(message: str, *, limit: int = 500) -> str:
    """Normalize a user-safe message before persistence or CLI rendering."""

    normalized = " ".join(message.replace("\x00", "").split())
    return normalized[:limit] or "Operation failed"


class DiandianError(Exception):
    """Base typed exception carrying a stable category and public message."""

    def __init__(
        self,
        code: ErrorCode,
        message: str,
        *,
        retryable: bool | None = None,
    ) -> None:
        public_message = safe_public_message(message)
        super().__init__(public_message)
        self.code = code
        self.message = public_message
        self.public_message = public_message
        self.retryable = is_retryable_error(code) if retryable is None else retryable


class InvalidStateTransition(DiandianError):
    """Raised when a domain transition violates its state machine."""

    def __init__(self, message: str) -> None:
        super().__init__(ErrorCode.UNEXPECTED, message, retryable=False)


class RepositoryConflict(DiandianError):
    """Raised when optimistic persistence detects a concurrent writer."""

    def __init__(self, message: str) -> None:
        super().__init__(ErrorCode.REPOSITORY_CONFLICT, message)


class UnsafePathError(DiandianError):
    """Raised before opening a path that violates local storage policy."""

    def __init__(self, message: str) -> None:
        super().__init__(ErrorCode.VALIDATION, message, retryable=False)
