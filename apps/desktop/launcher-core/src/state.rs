//! The launcher lifecycle state machine from desktop-application-plan section 8.1.
//!
//! Modelling the lifecycle explicitly is what makes "no orphan process" auditable:
//! every path that leaves a running sidecar behind has to pass through
//! [`LauncherState::Stopping`], and illegal shortcuts are rejected rather than
//! silently tolerated.

use std::error::Error;
use std::fmt;

/// Lifecycle states of the desktop launcher.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LauncherState {
    /// The process started and has not yet spawned a sidecar.
    Launching,
    /// The sidecar was spawned; its control frame has not been verified yet.
    SidecarStarting,
    /// The control frame was verified; no window exists yet.
    SidecarReady,
    /// The product window is open on the verified local origin.
    WindowReady,
    /// A terminal failure was observed; only shutdown may follow.
    Failed,
    /// Shutdown is in progress; the child is being terminated and reaped.
    Stopping,
    /// Shutdown completed with no surviving child.
    Stopped,
}

impl fmt::Display for LauncherState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::Launching => "Launching",
            Self::SidecarStarting => "SidecarStarting",
            Self::SidecarReady => "SidecarReady",
            Self::WindowReady => "WindowReady",
            Self::Failed => "Failed",
            Self::Stopping => "Stopping",
            Self::Stopped => "Stopped",
        };
        formatter.write_str(name)
    }
}

/// A transition the lifecycle does not permit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IllegalTransition {
    /// State the machine was in.
    pub from: LauncherState,
    /// State that was requested.
    pub to: LauncherState,
}

impl fmt::Display for IllegalTransition {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "illegal transition {} -> {}", self.from, self.to)
    }
}

impl Error for IllegalTransition {}

/// Guards the launcher lifecycle against out-of-order transitions.
#[derive(Debug, Clone)]
pub struct LauncherStateMachine {
    state: LauncherState,
}

impl Default for LauncherStateMachine {
    fn default() -> Self {
        Self::new()
    }
}

impl LauncherStateMachine {
    /// Start in [`LauncherState::Launching`].
    #[must_use]
    pub fn new() -> Self {
        Self {
            state: LauncherState::Launching,
        }
    }

    /// Current state.
    #[must_use]
    pub fn state(&self) -> LauncherState {
        self.state
    }

    /// Whether the sidecar may still be running and therefore must be reaped.
    #[must_use]
    pub fn child_may_be_running(&self) -> bool {
        matches!(
            self.state,
            LauncherState::SidecarStarting
                | LauncherState::SidecarReady
                | LauncherState::WindowReady
                | LauncherState::Failed
                | LauncherState::Stopping
        )
    }

    /// Apply a transition.
    ///
    /// # Errors
    ///
    /// Returns [`IllegalTransition`] when the edge is not in the lifecycle graph.
    pub fn transition(&mut self, to: LauncherState) -> Result<(), IllegalTransition> {
        if Self::allows(self.state, to) {
            self.state = to;
            return Ok(());
        }
        Err(IllegalTransition {
            from: self.state,
            to,
        })
    }

    fn allows(from: LauncherState, to: LauncherState) -> bool {
        use LauncherState::{
            Failed, Launching, SidecarReady, SidecarStarting, Stopped, Stopping, WindowReady,
        };
        matches!(
            (from, to),
            (Launching, SidecarStarting)
                | (SidecarStarting, SidecarReady | Failed)
                | (SidecarReady, WindowReady | Failed)
                | (WindowReady, Stopping | Failed)
                | (Failed, Stopping)
                | (Stopping, Stopped)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{LauncherState, LauncherStateMachine};

    #[test]
    fn follows_the_documented_happy_path() {
        let mut machine = LauncherStateMachine::new();
        assert_eq!(machine.state(), LauncherState::Launching);
        for next in [
            LauncherState::SidecarStarting,
            LauncherState::SidecarReady,
            LauncherState::WindowReady,
            LauncherState::Stopping,
            LauncherState::Stopped,
        ] {
            machine.transition(next).expect("edge is documented");
            assert_eq!(machine.state(), next);
        }
    }

    #[test]
    fn every_running_state_can_fail_then_stop() {
        for entry in [
            LauncherState::SidecarStarting,
            LauncherState::SidecarReady,
            LauncherState::WindowReady,
        ] {
            let mut machine = LauncherStateMachine::new();
            machine
                .transition(LauncherState::SidecarStarting)
                .expect("edge is documented");
            if entry != LauncherState::SidecarStarting {
                machine
                    .transition(LauncherState::SidecarReady)
                    .expect("edge is documented");
            }
            if entry == LauncherState::WindowReady {
                machine
                    .transition(LauncherState::WindowReady)
                    .expect("edge is documented");
            }
            machine
                .transition(LauncherState::Failed)
                .expect("failure is reachable from every running state");
            machine
                .transition(LauncherState::Stopping)
                .expect("failure must still reap the child");
            machine
                .transition(LauncherState::Stopped)
                .expect("shutdown completes");
        }
    }

    #[test]
    fn rejects_skipping_readiness() {
        let mut machine = LauncherStateMachine::new();
        machine
            .transition(LauncherState::SidecarStarting)
            .expect("edge is documented");
        let error = machine
            .transition(LauncherState::WindowReady)
            .expect_err("a window must not open before the control frame is verified");
        assert_eq!(error.from, LauncherState::SidecarStarting);
        assert_eq!(error.to, LauncherState::WindowReady);
    }

    #[test]
    fn rejects_restart_and_post_stop_transitions() {
        let mut machine = LauncherStateMachine::new();
        assert!(machine.transition(LauncherState::Launching).is_err());
        machine
            .transition(LauncherState::SidecarStarting)
            .expect("edge is documented");
        assert!(machine.transition(LauncherState::SidecarStarting).is_err());
        machine
            .transition(LauncherState::Failed)
            .expect("edge is documented");
        machine
            .transition(LauncherState::Stopping)
            .expect("edge is documented");
        machine
            .transition(LauncherState::Stopped)
            .expect("edge is documented");
        assert!(machine.transition(LauncherState::SidecarStarting).is_err());
        assert!(machine.transition(LauncherState::Stopping).is_err());
    }

    #[test]
    fn reports_when_a_child_still_needs_reaping() {
        let mut machine = LauncherStateMachine::new();
        assert!(!machine.child_may_be_running());
        machine
            .transition(LauncherState::SidecarStarting)
            .expect("edge is documented");
        assert!(machine.child_may_be_running());
        machine
            .transition(LauncherState::Failed)
            .expect("edge is documented");
        assert!(machine.child_may_be_running());
        machine
            .transition(LauncherState::Stopping)
            .expect("edge is documented");
        assert!(machine.child_may_be_running());
        machine
            .transition(LauncherState::Stopped)
            .expect("edge is documented");
        assert!(!machine.child_may_be_running());
    }
}
