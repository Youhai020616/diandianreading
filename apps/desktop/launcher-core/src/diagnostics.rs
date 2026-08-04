//! Typed, redacted classification of sidecar startup failures.
//!
//! The sidecar writes one bounded JSON object to stderr when it cannot start
//! (`_emit_startup_failure` in `desktop_sidecar.py`). The launcher surfaces only
//! the category: messages and paths from a child process are untrusted input and
//! must not reach a window, a log file, or a crash report verbatim.

use std::fmt;

/// Largest stderr line the launcher will inspect.
pub const MAX_DIAGNOSTIC_BYTES: usize = 4096;

/// Startup failure categories the launcher can present.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum StartupErrorCode {
    /// The bundled Chromium runtime was missing or failed validation.
    BrowserUnavailable,
    /// The fixed port was not available to the sidecar.
    PortUnavailable,
    /// A recognised but unclassified startup failure.
    StartFailed,
    /// The sidecar reported an unexpected exception category.
    Unexpected,
    /// Nothing parseable arrived on stderr.
    Unrecognised,
}

impl fmt::Display for StartupErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self {
            Self::BrowserUnavailable => "SIDECAR_BROWSER_UNAVAILABLE",
            Self::PortUnavailable => "SIDECAR_PORT_UNAVAILABLE",
            Self::StartFailed => "SIDECAR_START_FAILED",
            Self::Unexpected => "SIDECAR_UNEXPECTED",
            Self::Unrecognised => "SIDECAR_UNRECOGNISED",
        };
        formatter.write_str(code)
    }
}

/// Classify one stderr line without retaining any of its free text.
#[must_use]
pub fn classify(line: &str) -> StartupErrorCode {
    if line.is_empty() || line.len() > MAX_DIAGNOSTIC_BYTES {
        return StartupErrorCode::Unrecognised;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return StartupErrorCode::Unrecognised;
    };
    let code = value
        .get("error")
        .and_then(|error| error.get("code"))
        .and_then(serde_json::Value::as_str);
    match code {
        Some("SIDECAR_BROWSER_UNAVAILABLE") => StartupErrorCode::BrowserUnavailable,
        Some("SIDECAR_PORT_UNAVAILABLE") => StartupErrorCode::PortUnavailable,
        Some("SIDECAR_START_FAILED") => StartupErrorCode::StartFailed,
        Some(other) if other.starts_with("SIDECAR_UNEXPECTED_") => StartupErrorCode::Unexpected,
        _ => StartupErrorCode::Unrecognised,
    }
}

#[cfg(test)]
mod tests {
    use super::{classify, StartupErrorCode, MAX_DIAGNOSTIC_BYTES};

    fn failure(code: &str) -> String {
        format!(
            r#"{{"status":"error","error":{{"code":"{code}","message":"Desktop sidecar could not start","retryable":false}}}}"#
        )
    }

    #[test]
    fn classifies_the_documented_codes() {
        assert_eq!(
            classify(&failure("SIDECAR_BROWSER_UNAVAILABLE")),
            StartupErrorCode::BrowserUnavailable
        );
        assert_eq!(
            classify(&failure("SIDECAR_PORT_UNAVAILABLE")),
            StartupErrorCode::PortUnavailable
        );
        assert_eq!(
            classify(&failure("SIDECAR_START_FAILED")),
            StartupErrorCode::StartFailed
        );
        assert_eq!(
            classify(&failure("SIDECAR_UNEXPECTED_RUNTIMEERROR")),
            StartupErrorCode::Unexpected
        );
    }

    #[test]
    fn refuses_unknown_empty_and_oversized_input() {
        assert_eq!(classify(""), StartupErrorCode::Unrecognised);
        assert_eq!(classify("plain crash text"), StartupErrorCode::Unrecognised);
        assert_eq!(
            classify(&failure("SOMETHING_ELSE")),
            StartupErrorCode::Unrecognised
        );
        let oversized = "a".repeat(MAX_DIAGNOSTIC_BYTES + 1);
        assert_eq!(classify(&oversized), StartupErrorCode::Unrecognised);
    }

    #[test]
    fn rendered_codes_never_include_child_supplied_text() {
        let line = failure("SIDECAR_PORT_UNAVAILABLE");
        let rendered = classify(&line).to_string();
        assert_eq!(rendered, "SIDECAR_PORT_UNAVAILABLE");
        assert!(!rendered.contains("could not start"));
    }
}
