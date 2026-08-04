//! Child-process supervision that leaves no orphan behind.
//!
//! The exit criteria for D2 require that cold start, repeated start, sidecar
//! crash and launcher crash all end with no surviving child. The guard here makes
//! that a property of stack unwinding rather than of remembering to call a
//! shutdown function on every path, including panics.

use std::io;
use std::process::Child;

/// The minimum a launcher needs from a spawned process.
pub trait ChildHandle {
    /// Request termination.
    ///
    /// # Errors
    ///
    /// Returns the platform error when the signal could not be delivered.
    fn kill(&mut self) -> io::Result<()>;

    /// Reap the process, blocking until it is gone.
    ///
    /// # Errors
    ///
    /// Returns the platform error when the process could not be waited on.
    fn wait(&mut self) -> io::Result<()>;
}

impl ChildHandle for Child {
    fn kill(&mut self) -> io::Result<()> {
        Child::kill(self)
    }

    fn wait(&mut self) -> io::Result<()> {
        Child::wait(self).map(|_| ())
    }
}

/// Owns a child and terminates it on drop.
#[derive(Debug)]
pub struct SupervisedChild<C: ChildHandle> {
    child: Option<C>,
}

impl<C: ChildHandle> SupervisedChild<C> {
    /// Take ownership of a freshly spawned child.
    pub fn new(child: C) -> Self {
        Self { child: Some(child) }
    }

    /// Borrow the child while it is still supervised.
    pub fn get_mut(&mut self) -> Option<&mut C> {
        self.child.as_mut()
    }

    /// Whether a child is still owned.
    #[must_use]
    pub fn is_running(&self) -> bool {
        self.child.is_some()
    }

    /// Terminate and reap the child. Idempotent.
    ///
    /// # Errors
    ///
    /// Returns the first platform error from kill or wait; the child is released
    /// either way so a second call cannot double-signal an unrelated process.
    pub fn shutdown(&mut self) -> io::Result<()> {
        let Some(mut child) = self.child.take() else {
            return Ok(());
        };
        let killed = child.kill();
        let waited = child.wait();
        killed.and(waited)
    }
}

impl<C: ChildHandle> Drop for SupervisedChild<C> {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::{ChildHandle, SupervisedChild};
    use std::cell::RefCell;
    use std::io;
    use std::rc::Rc;

    #[derive(Default)]
    struct Record {
        kills: usize,
        waits: usize,
    }

    struct FakeChild {
        record: Rc<RefCell<Record>>,
        kill_fails: bool,
    }

    impl ChildHandle for FakeChild {
        fn kill(&mut self) -> io::Result<()> {
            self.record.borrow_mut().kills += 1;
            if self.kill_fails {
                return Err(io::Error::other("kill failed"));
            }
            Ok(())
        }

        fn wait(&mut self) -> io::Result<()> {
            self.record.borrow_mut().waits += 1;
            Ok(())
        }
    }

    fn fake(record: &Rc<RefCell<Record>>, kill_fails: bool) -> FakeChild {
        FakeChild {
            record: Rc::clone(record),
            kill_fails,
        }
    }

    #[test]
    fn drop_terminates_and_reaps() {
        let record = Rc::new(RefCell::new(Record::default()));
        {
            let _guard = SupervisedChild::new(fake(&record, false));
        }
        assert_eq!(record.borrow().kills, 1);
        assert_eq!(record.borrow().waits, 1);
    }

    #[test]
    fn shutdown_is_idempotent_and_drop_does_not_repeat_it() {
        let record = Rc::new(RefCell::new(Record::default()));
        let mut guard = SupervisedChild::new(fake(&record, false));
        guard.shutdown().expect("first shutdown succeeds");
        guard.shutdown().expect("second shutdown is a no-op");
        assert!(!guard.is_running());
        drop(guard);
        assert_eq!(record.borrow().kills, 1);
        assert_eq!(record.borrow().waits, 1);
    }

    #[test]
    fn a_panic_still_reaps_the_child() {
        let record = Rc::new(RefCell::new(Record::default()));
        let record_for_panic = Rc::clone(&record);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _guard = SupervisedChild::new(fake(&record_for_panic, false));
            panic!("launcher failed while the sidecar was running");
        }));
        assert!(result.is_err());
        assert_eq!(record.borrow().kills, 1);
        assert_eq!(record.borrow().waits, 1);
    }

    #[test]
    fn a_failing_kill_still_releases_and_still_waits() {
        let record = Rc::new(RefCell::new(Record::default()));
        let mut guard = SupervisedChild::new(fake(&record, true));
        assert!(guard.shutdown().is_err());
        assert!(!guard.is_running());
        assert_eq!(record.borrow().kills, 1);
        assert_eq!(record.borrow().waits, 1);
        drop(guard);
        assert_eq!(record.borrow().kills, 1);
    }
}
