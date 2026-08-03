from __future__ import annotations

import pytest
from notebooklm.exceptions import (
    ArtifactDownloadError,
    ArtifactError,
    ArtifactFeatureUnavailableError,
    ArtifactNotReadyError,
    ArtifactParseError,
    ArtifactTimeoutError,
    AuthError,
    ChatError,
    ChatResponseParseError,
    ConfigurationError,
    MissingDependencyError,
    NetworkError,
    NonIdempotentRetryError,
    NotebookLMError,
    RateLimitError,
    RPCError,
    ServerError,
    SourceAddError,
    SourceProcessingError,
    UnknownRPCMethodError,
    ValidationError,
)

from diandianreading.domain import ErrorCode
from diandianreading.infrastructure.notebooklm import (
    NotebookLMOperation,
    map_notebooklm_error,
)


@pytest.mark.parametrize(
    ("error", "operation", "code", "retryable"),
    [
        (
            AuthError("secret-cookie"),
            NotebookLMOperation.HEALTH,
            ErrorCode.AUTH_REQUIRED,
            False,
        ),
        (
            RateLimitError("secret-quota-payload"),
            NotebookLMOperation.GENERATE,
            ErrorCode.REMOTE_RATE_LIMITED,
            True,
        ),
        (
            NetworkError("secret-host"),
            NotebookLMOperation.QUERY,
            ErrorCode.REMOTE_UNAVAILABLE,
            True,
        ),
        (
            UnknownRPCMethodError("secret-wire-shape"),
            NotebookLMOperation.QUERY,
            ErrorCode.REMOTE_PROTOCOL_DRIFT,
            False,
        ),
        (
            SourceProcessingError("secret-source-id"),
            NotebookLMOperation.WAIT_SOURCE,
            ErrorCode.SOURCE_PROCESSING_FAILED,
            True,
        ),
        (
            ArtifactDownloadError("report", "secret-url", status_code=500),
            NotebookLMOperation.DOWNLOAD,
            ErrorCode.CONVERSION_FAILED,
            True,
        ),
        (
            ValidationError("secret-file-name"),
            NotebookLMOperation.UPLOAD_SOURCE,
            ErrorCode.FORMAT_UNSUPPORTED,
            False,
        ),
        (
            ChatResponseParseError("secret-response"),
            NotebookLMOperation.QUERY,
            ErrorCode.REMOTE_PROTOCOL_DRIFT,
            False,
        ),
        (
            NonIdempotentRetryError("secret-operation"),
            NotebookLMOperation.GENERATE,
            ErrorCode.REMOTE_PROTOCOL_DRIFT,
            False,
        ),
        (
            ConfigurationError("secret-config"),
            NotebookLMOperation.HEALTH,
            ErrorCode.AUTH_REQUIRED,
            False,
        ),
        (
            ArtifactDownloadError("report", "secret-auth", status_code=401),
            NotebookLMOperation.DOWNLOAD,
            ErrorCode.AUTH_REQUIRED,
            False,
        ),
        (
            ArtifactDownloadError("report", "secret-rate-limit", status_code=429),
            NotebookLMOperation.DOWNLOAD,
            ErrorCode.REMOTE_RATE_LIMITED,
            True,
        ),
        (
            ArtifactTimeoutError("notebook", "task", 1),
            NotebookLMOperation.WAIT_GENERATION,
            ErrorCode.REMOTE_UNAVAILABLE,
            True,
        ),
        (
            ArtifactFeatureUnavailableError("report"),
            NotebookLMOperation.GENERATE,
            ErrorCode.FORMAT_UNSUPPORTED,
            False,
        ),
        (
            ArtifactNotReadyError("report", "artifact"),
            NotebookLMOperation.DOWNLOAD,
            ErrorCode.CONVERSION_FAILED,
            False,
        ),
        (
            ArtifactParseError("report", "secret-data"),
            NotebookLMOperation.DOWNLOAD,
            ErrorCode.CONVERSION_FAILED,
            False,
        ),
        (
            MissingDependencyError("secret-package"),
            NotebookLMOperation.GENERATE,
            ErrorCode.FORMAT_UNSUPPORTED,
            False,
        ),
        (
            SourceAddError("secret-source"),
            NotebookLMOperation.UPLOAD_SOURCE,
            ErrorCode.REMOTE_UNAVAILABLE,
            True,
        ),
        (
            ServerError("secret-server", status_code=503),
            NotebookLMOperation.HEALTH,
            ErrorCode.REMOTE_UNAVAILABLE,
            True,
        ),
        (
            ChatError("secret-chat"),
            NotebookLMOperation.QUERY,
            ErrorCode.REMOTE_UNAVAILABLE,
            True,
        ),
        (
            RPCError("secret-rpc"),
            NotebookLMOperation.GENERATE,
            ErrorCode.REMOTE_PROTOCOL_DRIFT,
            False,
        ),
        (
            ArtifactError("secret-artifact"),
            NotebookLMOperation.GENERATE,
            ErrorCode.CONVERSION_FAILED,
            False,
        ),
        (
            ValidationError("secret-query"),
            NotebookLMOperation.QUERY,
            ErrorCode.VALIDATION,
            False,
        ),
        (
            NotebookLMError("secret-provider"),
            NotebookLMOperation.CLOSE,
            ErrorCode.REMOTE_PROTOCOL_DRIFT,
            False,
        ),
        (
            RuntimeError("secret-runtime"),
            NotebookLMOperation.CLOSE,
            ErrorCode.UNEXPECTED,
            False,
        ),
    ],
)
def test_public_sdk_exceptions_map_to_stable_redacted_product_errors(
    error,
    operation,
    code,
    retryable,
) -> None:
    mapped = map_notebooklm_error(error, operation)

    assert mapped.code is code
    assert mapped.retryable is retryable
    assert "secret" not in mapped.public_message.lower()
