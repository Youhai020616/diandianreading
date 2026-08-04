//! Platform-independent launcher logic for the diandianreading desktop shell.
//!
//! The Tauri binary in `../src-tauri` is deliberately a thin wiring layer: every
//! decision that can be wrong in a security-relevant way lives here, where it is
//! testable on any host without a `WebView`, a window server, or a macOS bundle.
//!
//! The contracts implemented here mirror
//! `src/diandianreading/interfaces/desktop_sidecar.py` and the control protocol,
//! port and adoption rules in `docs/architecture/desktop-application-plan.md`
//! sections 8.1 to 8.3.

pub mod control;
pub mod diagnostics;
pub mod port;
pub mod sidecar;
pub mod state;
pub mod supervisor;
