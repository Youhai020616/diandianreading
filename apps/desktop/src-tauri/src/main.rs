#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Thin wiring layer for the diandianreading desktop shell.
//!
//! Every decision with a security consequence lives in `launcher-core`, which is
//! unit tested on any host. This binary only sequences those decisions against
//! the Tauri runtime: take the single-instance lock, refuse an occupied port,
//! start the one bundled sidecar, verify its control frame, open exactly one
//! window on the verified origin, and reap the child on every exit path.

use std::io::{BufRead, BufReader, Read};
use std::process::{Child, ChildStderr, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use launcher_core::control::{product_url, read_ready_frame};
use launcher_core::diagnostics::{classify, StartupErrorCode, MAX_DIAGNOSTIC_BYTES};
use launcher_core::port::{probe_fixed_port, PortAvailability};
use launcher_core::sidecar::resolve_bundled;
use launcher_core::state::{LauncherState, LauncherStateMachine};
use launcher_core::supervisor::SupervisedChild;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};

/// The only window this application ever creates.
const WINDOW_LABEL: &str = "main";

/// How long the launcher waits for the sidecar to authenticate itself.
const READY_TIMEOUT: Duration = Duration::from_secs(90);

/// How long a failed startup waits for the child's own diagnostic line.
const DIAGNOSTIC_TIMEOUT: Duration = Duration::from_secs(2);

/// Shared launcher lifecycle state.
struct Launcher {
    machine: Mutex<LauncherStateMachine>,
    child: Mutex<Option<SupervisedChild<Child>>>,
}

impl Launcher {
    fn new() -> Self {
        Self {
            machine: Mutex::new(LauncherStateMachine::new()),
            child: Mutex::new(None),
        }
    }

    /// Apply a lifecycle transition, ignoring poisoning during teardown.
    fn advance(&self, to: LauncherState) {
        if let Ok(mut machine) = self.machine.lock() {
            let _ = machine.transition(to);
        }
    }

    /// Terminate and reap the sidecar. Safe to call more than once.
    fn shutdown(&self) {
        if let Ok(mut machine) = self.machine.lock() {
            match machine.state() {
                LauncherState::SidecarStarting | LauncherState::SidecarReady => {
                    let _ = machine.transition(LauncherState::Failed);
                    let _ = machine.transition(LauncherState::Stopping);
                }
                LauncherState::WindowReady | LauncherState::Failed => {
                    let _ = machine.transition(LauncherState::Stopping);
                }
                _ => {}
            }
        }
        if let Ok(mut slot) = self.child.lock() {
            if let Some(mut child) = slot.take() {
                let _ = child.shutdown();
            }
        }
        self.advance(LauncherState::Stopped);
    }
}

/// Whether a navigation target is the verified product origin.
fn is_product_origin(url: &Url) -> bool {
    url.scheme() == "http" && url.host_str() == Some("localhost") && url.port() == Some(3000)
}

/// Classify the sidecar's first stderr line, then keep the pipe drained.
///
/// Draining matters as much as classifying. A piped stderr that nobody reads
/// fills at roughly one buffer's worth of output and then blocks the child
/// forever, which would strand a long-running session behind a write that never
/// completes. The reader therefore keeps consuming for the life of the child and
/// discards everything after the one line it reports.
fn spawn_stderr_reader(stderr: ChildStderr) -> mpsc::Receiver<StartupErrorCode> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut first = String::new();
        let code = {
            let mut limited = Read::take(&mut reader, MAX_DIAGNOSTIC_BYTES as u64 + 1);
            match limited.read_line(&mut first) {
                Ok(0) | Err(_) => StartupErrorCode::Unrecognised,
                Ok(_) => classify(first.trim_end()),
            }
        };
        let _ = sender.send(code);
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
    });
    receiver
}

/// Open the single product window on the verified origin.
fn open_product_window(handle: &AppHandle, url: &str) -> Result<(), Box<dyn std::error::Error>> {
    let target: Url = url.parse()?;
    WebviewWindowBuilder::new(handle, WINDOW_LABEL, WebviewUrl::External(target))
        .title("diandianreading")
        .inner_size(1280.0, 860.0)
        .min_inner_size(960.0, 640.0)
        .on_navigation(is_product_origin)
        .build()?;
    Ok(())
}

/// Start the bundled sidecar and return the one-time product URL.
fn start_sidecar(app: &AppHandle, launcher: &Launcher) -> Result<String, StartupErrorCode> {
    // Probing releases the port before the child binds it, so this check is an
    // early, friendly refusal rather than a reservation. The sidecar performs the
    // authoritative bind and fails closed with SIDECAR_PORT_UNAVAILABLE if it
    // loses the race; neither side ever falls back to another port.
    if probe_fixed_port() == PortAvailability::Occupied {
        return Err(StartupErrorCode::PortUnavailable);
    }

    let resources = app
        .path()
        .resource_dir()
        .map_err(|_| StartupErrorCode::StartFailed)?;
    let binary = resolve_bundled(&resources).map_err(|_| StartupErrorCode::StartFailed)?;
    let home = app
        .path()
        .app_data_dir()
        .map_err(|_| StartupErrorCode::StartFailed)?;
    std::fs::create_dir_all(&home).map_err(|_| StartupErrorCode::StartFailed)?;

    let mut child = Command::new(&binary)
        .arg("--home")
        .arg(&home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| StartupErrorCode::StartFailed)?;
    launcher.advance(LauncherState::SidecarStarting);

    let stdout = child.stdout.take().ok_or(StartupErrorCode::StartFailed)?;
    let diagnostics = child.stderr.take().map(spawn_stderr_reader);
    let mut supervised = SupervisedChild::new(child);

    // The reader runs off-thread so a child that never speaks cannot hang the
    // launcher; the nonce becomes a URL immediately and is never stored.
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(read_ready_frame(BufReader::new(stdout)).map(product_url));
    });

    let url = match receiver.recv_timeout(READY_TIMEOUT) {
        Ok(Ok(url)) => url,
        Ok(Err(_)) | Err(_) => {
            let code = diagnostics
                .and_then(|codes| codes.recv_timeout(DIAGNOSTIC_TIMEOUT).ok())
                .unwrap_or(StartupErrorCode::StartFailed);
            let _ = supervised.shutdown();
            return Err(code);
        }
    };

    match launcher.child.lock() {
        Ok(mut slot) => *slot = Some(supervised),
        Err(_) => {
            let _ = supervised.shutdown();
            return Err(StartupErrorCode::StartFailed);
        }
    }
    Ok(url)
}

fn main() {
    let app = tauri::Builder::default()
        // Registered first so a second launch focuses the existing window
        // instead of racing for the port and starting a second sidecar.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(Launcher::new())
        .setup(|app| {
            let handle = app.handle().clone();
            let launcher = handle.state::<Launcher>();
            match start_sidecar(&handle, &launcher) {
                Ok(url) => {
                    launcher.advance(LauncherState::SidecarReady);
                    // A window failure must reap the child here rather than rely
                    // on teardown order: the sidecar is already running and
                    // already owns port 3000.
                    match open_product_window(&handle, &url) {
                        Ok(()) => launcher.advance(LauncherState::WindowReady),
                        Err(error) => {
                            launcher.advance(LauncherState::Failed);
                            launcher.shutdown();
                            return Err(error);
                        }
                    }
                }
                Err(code) => {
                    // Only the category reaches the terminal; child text is untrusted.
                    eprintln!("{code}");
                    launcher.advance(LauncherState::Failed);
                    launcher.shutdown();
                    handle.exit(2);
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("desktop shell context is valid");

    app.run(|handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            handle.state::<Launcher>().shutdown();
        }
    });
}
