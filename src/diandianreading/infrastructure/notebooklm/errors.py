"""Stable product error mapping for the public notebooklm-py exception surface."""

from __future__ import annotations

from enum import StrEnum

from notebooklm.exceptions import (
    ArtifactDownloadError,
    ArtifactError,
    ArtifactFeatureUnavailableError,
    ArtifactNotFoundError,
    ArtifactNotReadyError,
    ArtifactParseError,
    ArtifactTimeoutError,
    AuthError,
    AuthExtractionError,
    ChatError,
    ChatResponseParseError,
    ClientError,
    ConfigurationError,
    DecodingError,
    HeadlessLoginRequiredError,
    MissingDependencyError,
    NetworkError,
    NonIdempotentRetryError,
    NotebookLimitError,
    NotebookLMError,
    NotebookNotFoundError,
    RateLimitError,
    RPCError,
    RPCTimeoutError,
    ServerError,
    SourceAddError,
    SourceNotFoundError,
    SourceProcessingError,
    SourceTimeoutError,
    UnknownRPCMethodError,
    ValidationError,
    WaitTimeoutError,
)

from diandianreading.domain import DiandianError, ErrorCode


class NotebookLMOperation(StrEnum):
    HEALTH = "health"
    CREATE_WORKSPACE = "create_workspace"
    UPLOAD_SOURCE = "upload_source"
    WAIT_SOURCE = "wait_source"
    QUERY = "query"
    GENERATE = "generate"
    WAIT_GENERATION = "wait_generation"
    DOWNLOAD = "download"
    CLOSE = "close"


def map_notebooklm_error(error: Exception, operation: NotebookLMOperation) -> DiandianError:
    """Translate an SDK failure without exposing provider payloads or physical paths."""

    if isinstance(error, DiandianError):
        return error
    if isinstance(error, MissingDependencyError):
        return DiandianError(
            ErrorCode.FORMAT_UNSUPPORTED,
            "NotebookLM requires an unavailable optional format dependency",
            retryable=False,
        )
    if isinstance(
        error,
        (AuthError, AuthExtractionError, ConfigurationError, HeadlessLoginRequiredError),
    ):
        return DiandianError(
            ErrorCode.AUTH_REQUIRED,
            "NotebookLM authentication is missing or expired",
            retryable=False,
        )
    if isinstance(error, (RateLimitError, NotebookLimitError)):
        return DiandianError(
            ErrorCode.REMOTE_RATE_LIMITED,
            "NotebookLM rate limit or account quota was reached",
            retryable=True,
        )
    if isinstance(error, (SourceProcessingError, SourceTimeoutError, SourceNotFoundError)):
        return DiandianError(
            ErrorCode.SOURCE_PROCESSING_FAILED,
            "NotebookLM source processing did not complete successfully",
            retryable=True,
        )
    if isinstance(error, ArtifactDownloadError):
        if error.status_code in {401, 403}:
            return DiandianError(
                ErrorCode.AUTH_REQUIRED,
                "NotebookLM authentication is missing or expired",
                retryable=False,
            )
        if error.status_code == 429:
            return DiandianError(
                ErrorCode.REMOTE_RATE_LIMITED,
                "NotebookLM rate limit or account quota was reached",
                retryable=True,
            )
        return DiandianError(
            ErrorCode.CONVERSION_FAILED,
            "NotebookLM generated content could not be downloaded",
            retryable=error.status_code is None or error.status_code >= 500,
        )
    if isinstance(error, (ArtifactTimeoutError, WaitTimeoutError)):
        return DiandianError(
            ErrorCode.REMOTE_UNAVAILABLE,
            "NotebookLM did not complete the remote operation before the timeout",
            retryable=True,
        )
    if isinstance(error, ArtifactFeatureUnavailableError):
        return DiandianError(
            ErrorCode.FORMAT_UNSUPPORTED,
            "The requested NotebookLM content type is unavailable",
            retryable=False,
        )
    if isinstance(error, (ArtifactNotFoundError, ArtifactNotReadyError, ArtifactParseError)):
        return DiandianError(
            ErrorCode.CONVERSION_FAILED,
            "NotebookLM generated content is unavailable or invalid",
            retryable=False,
        )
    if isinstance(error, ArtifactError):
        return DiandianError(
            ErrorCode.CONVERSION_FAILED,
            "NotebookLM content generation failed",
            retryable=False,
        )
    if isinstance(error, ValidationError):
        code = (
            ErrorCode.FORMAT_UNSUPPORTED
            if operation in {NotebookLMOperation.UPLOAD_SOURCE, NotebookLMOperation.GENERATE}
            else ErrorCode.VALIDATION
        )
        return DiandianError(code, "NotebookLM rejected the operation input", retryable=False)
    if isinstance(error, SourceAddError):
        return DiandianError(
            ErrorCode.REMOTE_UNAVAILABLE,
            "NotebookLM could not accept the source upload",
            retryable=True,
        )
    if isinstance(error, (NetworkError, RPCTimeoutError, ServerError)):
        return DiandianError(
            ErrorCode.REMOTE_UNAVAILABLE,
            "NotebookLM is temporarily unavailable",
            retryable=True,
        )
    if isinstance(error, ChatResponseParseError):
        return DiandianError(
            ErrorCode.REMOTE_PROTOCOL_DRIFT,
            "NotebookLM returned an unrecognized chat response",
            retryable=False,
        )
    if isinstance(error, ChatError):
        return DiandianError(
            ErrorCode.REMOTE_UNAVAILABLE,
            "NotebookLM could not complete the question",
            retryable=True,
        )
    if isinstance(error, NonIdempotentRetryError):
        return DiandianError(
            ErrorCode.REMOTE_PROTOCOL_DRIFT,
            "NotebookLM could not guarantee an idempotent retry",
            retryable=False,
        )
    if isinstance(error, NotebookNotFoundError):
        return DiandianError(
            ErrorCode.REMOTE_UNAVAILABLE,
            "The NotebookLM workspace is no longer available",
            retryable=False,
        )
    if isinstance(error, (UnknownRPCMethodError, DecodingError, ClientError, RPCError)):
        return DiandianError(
            ErrorCode.REMOTE_PROTOCOL_DRIFT,
            "NotebookLM returned an unsupported protocol response",
            retryable=False,
        )
    if isinstance(error, NotebookLMError):
        return DiandianError(
            ErrorCode.REMOTE_PROTOCOL_DRIFT,
            "NotebookLM operation failed with an unsupported provider response",
            retryable=False,
        )
    return DiandianError(
        ErrorCode.UNEXPECTED,
        "Unexpected NotebookLM adapter failure",
        retryable=False,
    )
