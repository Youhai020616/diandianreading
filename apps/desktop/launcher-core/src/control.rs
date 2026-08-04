//! Bounded, strict parsing of the sidecar stdout control channel.
//!
//! This is the Rust counterpart of `parse_ready_control_frame` in
//! `src/diandianreading/interfaces/desktop_sidecar.py`. Both sides reject unknown
//! fields on purpose: accepting forward-compatible control semantics would turn a
//! future protocol mismatch into an unsafe attachment to some other local process.

use std::error::Error;
use std::fmt;
use std::io::BufRead;

/// Versioned control protocol identifier shared with the Python sidecar.
pub const CONTROL_PROTOCOL: &str = "diandian-desktop-v1";

/// The only origin the shell will ever load product UI from.
pub const LOCAL_ORIGIN: &str = "http://localhost:3000";

/// Hard upper bound for a single control frame, excluding its newline delimiter.
pub const MAX_CONTROL_FRAME_BYTES: usize = 4096;

/// Hard upper bound for the single-use bootstrap nonce.
pub const MAX_BOOTSTRAP_BYTES: usize = 512;

/// Why a control frame was rejected.
///
/// Variants are deliberately coarse and carry no payload: a launcher diagnostic
/// must never echo untrusted bytes, and never the bootstrap secret.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ControlFrameError {
    /// The frame was empty or exceeded [`MAX_CONTROL_FRAME_BYTES`].
    Size,
    /// The frame was not valid UTF-8 JSON.
    Encoding,
    /// The frame was not a JSON object with exactly the four expected string fields.
    Shape,
    /// The `protocol` or `event` field did not match the expected constants.
    Protocol,
    /// The `origin` field did not match [`LOCAL_ORIGIN`].
    Origin,
    /// The bootstrap nonce was empty, oversized, or contained unsafe characters.
    Bootstrap,
    /// The stream ended, failed, or overran the limit before a complete frame arrived.
    Truncated,
}

impl fmt::Display for ControlFrameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let reason = match self {
            Self::Size => "control frame size is invalid",
            Self::Encoding => "control frame is not valid UTF-8 JSON",
            Self::Shape => "control frame fields are invalid",
            Self::Protocol => "control frame protocol or event is invalid",
            Self::Origin => "control frame origin is invalid",
            Self::Bootstrap => "control frame bootstrap is invalid",
            Self::Truncated => "control frame was truncated",
        };
        formatter.write_str(reason)
    }
}

impl Error for ControlFrameError {}

/// A verified `ready` frame holding the single-use bootstrap nonce.
///
/// [`Debug`] is implemented by hand so the secret cannot reach a log line, a
/// panic message, or a crash report. The value is consumed by
/// [`ReadyFrame::into_bootstrap`], which makes single use a type-level property
/// rather than a convention.
pub struct ReadyFrame {
    bootstrap: String,
}

impl fmt::Debug for ReadyFrame {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReadyFrame")
            .field("bootstrap", &"<redacted>")
            .finish()
    }
}

impl ReadyFrame {
    /// Length of the nonce in bytes, for bounds assertions that must not read it.
    #[must_use]
    pub fn bootstrap_len(&self) -> usize {
        self.bootstrap.len()
    }

    /// Consume the frame and yield the nonce exactly once.
    #[must_use]
    pub fn into_bootstrap(self) -> String {
        self.bootstrap
    }
}

/// Parse exactly one bounded `ready` frame, rejecting anything else.
///
/// # Errors
///
/// Returns a [`ControlFrameError`] when the bytes are not a complete, in-bounds
/// frame carrying the expected protocol, event, origin and a safe nonce.
pub fn parse_ready_frame(encoded: &[u8]) -> Result<ReadyFrame, ControlFrameError> {
    if encoded.is_empty() || encoded.len() > MAX_CONTROL_FRAME_BYTES {
        return Err(ControlFrameError::Size);
    }
    let text = std::str::from_utf8(encoded).map_err(|_| ControlFrameError::Encoding)?;
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|_| ControlFrameError::Encoding)?;
    let object = value.as_object().ok_or(ControlFrameError::Shape)?;
    if object.len() != 4 {
        return Err(ControlFrameError::Shape);
    }
    let field = |name: &str| {
        object
            .get(name)
            .and_then(serde_json::Value::as_str)
            .ok_or(ControlFrameError::Shape)
    };
    let protocol = field("protocol")?;
    let event = field("event")?;
    let origin = field("origin")?;
    let bootstrap = field("bootstrap")?;

    if protocol != CONTROL_PROTOCOL || event != "ready" {
        return Err(ControlFrameError::Protocol);
    }
    if origin != LOCAL_ORIGIN {
        return Err(ControlFrameError::Origin);
    }
    if bootstrap.is_empty() || bootstrap.len() > MAX_BOOTSTRAP_BYTES {
        return Err(ControlFrameError::Bootstrap);
    }
    if !bootstrap.bytes().all(|byte| (0x21..=0x7E).contains(&byte)) {
        return Err(ControlFrameError::Bootstrap);
    }
    Ok(ReadyFrame {
        bootstrap: bootstrap.to_owned(),
    })
}

/// Read one newline-delimited frame from the sidecar, capping cumulative bytes.
///
/// A child that never emits a newline, or emits more than the protocol allows,
/// fails closed instead of letting the launcher buffer without bound.
///
/// # Errors
///
/// Returns a [`ControlFrameError`] on I/O failure, on a truncated or oversized
/// line, or when the completed line is not a valid `ready` frame.
pub fn read_ready_frame<R: BufRead>(reader: R) -> Result<ReadyFrame, ControlFrameError> {
    let mut buffer = Vec::with_capacity(256);
    let limit = MAX_CONTROL_FRAME_BYTES as u64 + 1;
    let mut limited = reader.take(limit);
    limited
        .read_until(b'\n', &mut buffer)
        .map_err(|_| ControlFrameError::Truncated)?;
    if buffer.last() != Some(&b'\n') {
        return Err(ControlFrameError::Truncated);
    }
    buffer.pop();
    parse_ready_frame(&buffer)
}

/// Build the one-time product URL that hands the nonce to the web UI.
///
/// The nonce travels in the URL fragment because fragments are not sent to the
/// server, do not appear in server logs, and are stripped by the web bootstrap
/// immediately after use (`apps/web/src/lib/bootstrap.ts`).
#[must_use]
pub fn product_url(frame: ReadyFrame) -> String {
    format!("{LOCAL_ORIGIN}/#bootstrap={}", frame.into_bootstrap())
}

#[cfg(test)]
mod tests {
    use super::{
        parse_ready_frame, product_url, read_ready_frame, ControlFrameError, MAX_BOOTSTRAP_BYTES,
        MAX_CONTROL_FRAME_BYTES,
    };
    use std::io::BufReader;

    fn frame(bootstrap: &str) -> String {
        format!(
            r#"{{"protocol":"diandian-desktop-v1","event":"ready","origin":"http://localhost:3000","bootstrap":"{bootstrap}"}}"#
        )
    }

    #[test]
    fn accepts_a_well_formed_frame() {
        let parsed = parse_ready_frame(frame("abc123").as_bytes()).expect("frame is valid");
        assert_eq!(parsed.bootstrap_len(), 6);
        assert_eq!(parsed.into_bootstrap(), "abc123");
    }

    #[test]
    fn debug_never_reveals_the_nonce() {
        let parsed = parse_ready_frame(frame("s3cr3t-value").as_bytes()).expect("frame is valid");
        let rendered = format!("{parsed:?}");
        assert!(rendered.contains("<redacted>"));
        assert!(!rendered.contains("s3cr3t-value"));
    }

    fn reject(encoded: &[u8]) -> ControlFrameError {
        parse_ready_frame(encoded).expect_err("frame must be rejected")
    }

    #[test]
    fn rejects_empty_and_oversized_frames() {
        assert_eq!(reject(b""), ControlFrameError::Size);
        let oversized = vec![b'{'; MAX_CONTROL_FRAME_BYTES + 1];
        assert_eq!(reject(&oversized), ControlFrameError::Size);
    }

    #[test]
    fn rejects_non_utf8_and_non_json() {
        assert_eq!(reject(&[0xff, 0xfe]), ControlFrameError::Encoding);
        assert_eq!(reject(b"not json"), ControlFrameError::Encoding);
    }

    #[test]
    fn rejects_non_object_and_unknown_fields() {
        assert_eq!(reject(b"[1,2]"), ControlFrameError::Shape);
        let extra = r#"{"protocol":"diandian-desktop-v1","event":"ready","origin":"http://localhost:3000","bootstrap":"abc","extra":1}"#;
        assert_eq!(reject(extra.as_bytes()), ControlFrameError::Shape);
        let missing = r#"{"protocol":"diandian-desktop-v1","event":"ready","origin":"http://localhost:3000"}"#;
        assert_eq!(reject(missing.as_bytes()), ControlFrameError::Shape);
    }

    #[test]
    fn rejects_non_string_fields() {
        let numeric = r#"{"protocol":"diandian-desktop-v1","event":"ready","origin":"http://localhost:3000","bootstrap":7}"#;
        assert_eq!(reject(numeric.as_bytes()), ControlFrameError::Shape);
    }

    #[test]
    fn rejects_wrong_protocol_event_and_origin() {
        let protocol = r#"{"protocol":"diandian-desktop-v2","event":"ready","origin":"http://localhost:3000","bootstrap":"abc"}"#;
        assert_eq!(reject(protocol.as_bytes()), ControlFrameError::Protocol);
        let event = r#"{"protocol":"diandian-desktop-v1","event":"started","origin":"http://localhost:3000","bootstrap":"abc"}"#;
        assert_eq!(reject(event.as_bytes()), ControlFrameError::Protocol);
        let origin = r#"{"protocol":"diandian-desktop-v1","event":"ready","origin":"http://127.0.0.1:3000","bootstrap":"abc"}"#;
        assert_eq!(reject(origin.as_bytes()), ControlFrameError::Origin);
    }

    #[test]
    fn rejects_unsafe_and_oversized_nonces() {
        assert_eq!(reject(frame("").as_bytes()), ControlFrameError::Bootstrap);
        assert_eq!(
            reject(frame("has space").as_bytes()),
            ControlFrameError::Bootstrap
        );
        let long = "a".repeat(MAX_BOOTSTRAP_BYTES + 1);
        assert_eq!(
            reject(frame(&long).as_bytes()),
            ControlFrameError::Bootstrap
        );
    }

    #[test]
    fn reads_one_frame_from_a_stream() {
        let stream = format!("{}\n", frame("nonce-1"));
        let reader = BufReader::new(stream.as_bytes());
        let parsed = read_ready_frame(reader).expect("frame is valid");
        assert_eq!(parsed.into_bootstrap(), "nonce-1");
    }

    #[test]
    fn rejects_a_stream_without_a_delimiter() {
        let stream = frame("nonce-1");
        let reader = BufReader::new(stream.as_bytes());
        assert_eq!(
            read_ready_frame(reader).expect_err("must be rejected"),
            ControlFrameError::Truncated
        );
    }

    #[test]
    fn rejects_a_stream_that_overruns_the_limit() {
        let flood = "a".repeat(MAX_CONTROL_FRAME_BYTES * 2);
        let reader = BufReader::new(flood.as_bytes());
        assert_eq!(
            read_ready_frame(reader).expect_err("must be rejected"),
            ControlFrameError::Truncated
        );
    }

    #[test]
    fn rejects_an_empty_stream() {
        let reader = BufReader::new(&b""[..]);
        assert_eq!(
            read_ready_frame(reader).expect_err("must be rejected"),
            ControlFrameError::Truncated
        );
    }

    #[test]
    fn product_url_places_the_nonce_in_the_fragment() {
        let parsed = parse_ready_frame(frame("nonce-2").as_bytes()).expect("frame is valid");
        assert_eq!(
            product_url(parsed),
            "http://localhost:3000/#bootstrap=nonce-2"
        );
    }
}
