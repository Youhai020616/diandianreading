//! Fixed-port and adoption policy from desktop-application-plan section 8.3.
//!
//! The rules encoded here are refusals. The launcher does not fall back to a
//! random port, does not terminate whatever holds the port, and does not adopt a
//! listening server merely because it answers `/healthz` correctly.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener};

/// The single port the product is served on.
pub const FIXED_PORT: u16 = 3000;

/// Result of probing the fixed port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortAvailability {
    /// Nothing is listening; the launcher may start its own sidecar.
    Available,
    /// Something already holds the port; the launcher must diagnose and exit.
    Occupied,
}

/// The loopback address the sidecar binds.
#[must_use]
pub fn fixed_address() -> SocketAddr {
    SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, FIXED_PORT))
}

/// Probe an address by attempting to bind it, then releasing it immediately.
///
/// Binding is used rather than connecting because a successful connect only
/// proves that *something* listens, which is not evidence the launcher is
/// allowed to act on.
#[must_use]
pub fn probe(address: SocketAddr) -> PortAvailability {
    match TcpListener::bind(address) {
        Ok(listener) => {
            drop(listener);
            PortAvailability::Available
        }
        Err(_) => PortAvailability::Occupied,
    }
}

/// Probe [`fixed_address`].
#[must_use]
pub fn probe_fixed_port() -> PortAvailability {
    probe(fixed_address())
}

/// Everything the launcher may know about an already-listening local server.
///
/// `healthz_ok` is recorded but deliberately excluded from the adoption decision:
/// section 8.3 rule 3 forbids attaching to a process just because it returns a
/// correct liveness response.
// Each field is an independent proof obligation from section 8.3; collapsing them
// into an enum would lose the "all of these, and liveness is not one of them"
// property that `may_adopt` and its tests assert.
#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AdoptionEvidence {
    /// The listener answered `/healthz` as the product would.
    pub healthz_ok: bool,
    /// This launcher created the process in this run.
    pub own_child_process: bool,
    /// The process authenticated itself over the parent-child control channel.
    pub control_frame_verified: bool,
    /// The install-instance identity matched.
    pub install_identity_matched: bool,
    /// The browser session was rotated after recovery.
    pub session_rotated: bool,
}

/// Whether the launcher may adopt an already-running server.
///
/// All four proofs are required; liveness alone never suffices.
#[must_use]
pub fn may_adopt(evidence: &AdoptionEvidence) -> bool {
    evidence.own_child_process
        && evidence.control_frame_verified
        && evidence.install_identity_matched
        && evidence.session_rotated
}

/// Actions the launcher is forbidden to take when the fixed port is occupied.
///
/// Kept as an explicit enum so the refusals are testable instead of implied by
/// the absence of code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ForbiddenPortAction {
    /// Choosing a different port when 3000 is taken.
    UseAnotherPort,
    /// Terminating the process that holds the port.
    TerminateHolder,
    /// Attaching to the listener without full adoption evidence.
    AttachWithoutProof,
}

/// Always false: none of these actions is ever permitted.
#[must_use]
pub fn permits(_action: ForbiddenPortAction) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::{
        fixed_address, may_adopt, permits, probe, AdoptionEvidence, ForbiddenPortAction,
        PortAvailability, FIXED_PORT,
    };
    use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener};

    fn ephemeral() -> SocketAddr {
        SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
    }

    #[test]
    fn fixed_address_is_loopback_3000() {
        let address = fixed_address();
        assert_eq!(address.port(), FIXED_PORT);
        assert!(address.ip().is_loopback());
    }

    #[test]
    fn reports_available_when_nothing_listens() {
        let listener = TcpListener::bind(ephemeral()).expect("ephemeral bind");
        let address = listener.local_addr().expect("address");
        drop(listener);
        assert_eq!(probe(address), PortAvailability::Available);
    }

    #[test]
    fn reports_occupied_when_something_listens() {
        let listener = TcpListener::bind(ephemeral()).expect("ephemeral bind");
        let address = listener.local_addr().expect("address");
        assert_eq!(probe(address), PortAvailability::Occupied);
        drop(listener);
    }

    #[test]
    fn healthz_alone_never_authorises_adoption() {
        let evidence = AdoptionEvidence {
            healthz_ok: true,
            ..AdoptionEvidence::default()
        };
        assert!(!may_adopt(&evidence));
    }

    #[test]
    fn adoption_requires_every_proof() {
        let complete = AdoptionEvidence {
            healthz_ok: false,
            own_child_process: true,
            control_frame_verified: true,
            install_identity_matched: true,
            session_rotated: true,
        };
        assert!(may_adopt(&complete));

        for drop_one in 0..4 {
            let mut partial = complete;
            match drop_one {
                0 => partial.own_child_process = false,
                1 => partial.control_frame_verified = false,
                2 => partial.install_identity_matched = false,
                _ => partial.session_rotated = false,
            }
            assert!(!may_adopt(&partial), "missing proof {drop_one} must refuse");
        }
    }

    #[test]
    fn forbidden_actions_stay_forbidden() {
        for action in [
            ForbiddenPortAction::UseAnotherPort,
            ForbiddenPortAction::TerminateHolder,
            ForbiddenPortAction::AttachWithoutProof,
        ] {
            assert!(!permits(action));
        }
    }
}
