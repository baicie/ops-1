// P001-C1.4 - one Node per state directory.
//
// Two Node processes sharing a state directory read the same `installation-id`
// and the same `node-identity.json`. They heartbeat one Kernel row, overwrite
// each other's `generation` / `last_seen_at` / `data_endpoint`, receive the
// same desired workloads and create the same instances - and, because the
// installation id is identical, each considers the other's containers its own.
// ADR-023 §2.2b lists this as out of scope; this module is where it stops being
// out of scope.
//
// ## What this is, precisely
//
// `flock(2)` with `LOCK_EX | LOCK_NB` on `<state_dir>/.node.lock`, held for the
// whole life of the process. It is an **advisory** lock: it constrains only
// processes that ask for it, so it cannot stop an older Node that predates this
// code. That limitation is stated in ADR-023 §2.6, not worked around here.
//
// ## Why the inode, not the path
//
// `flock` attaches to the open file description, which the kernel ties to the
// inode. Two processes that open the same path get the same inode and therefore
// contend. If the directory is deleted and re-created between the two opens,
// they get different inodes and both succeed - this module cannot prevent that
// and does not pretend to. The deployment Gate (03k) records it as risk 1.
//
// ## Why the file is never unlinked
//
// Unlinking on exit would let a later process create a NEW inode and lock it,
// while a process still holding the old inode believes it is exclusive. The
// kernel releases the lock when the process dies, including on SIGKILL, so no
// user-space cleanup is needed or wanted.
//
// ## Platform support
//
// Only Linux and macOS, and by explicit whitelist rather than `cfg(unix)`:
// `flock` exists on other Unixes with semantics this repository has never
// verified. Everything else refuses to start with
// `NODE_STATE_LOCK_UNSUPPORTED`.

use std::fs::File;
use std::path::{Path, PathBuf};

/// The lock file name inside the state directory.
pub const LOCK_FILE: &str = ".node.lock";

/// A held exclusive lock on one state directory.
///
/// Dropping it closes the file description, which releases the lock. The caller
/// must bind this to a named variable that lives as long as the process: an
/// unnamed temporary (`let _ = lock_state_dir(..)?;`) is dropped at the end of
/// the statement and the mutual exclusion never happens. `lock_state_dir` is
/// deliberately cheap to call and expensive to misuse, so the type is `#[must_use]`.
#[derive(Debug)]
#[must_use = "the lock is released when this value is dropped; bind it to a variable that lives for the whole process"]
pub struct StateDirLock {
    /// Kept only so the file description stays open. `flock` is released when
    /// the last descriptor for the open file description is closed, which is
    /// when this `File` is dropped.
    ///
    /// Never read: holding it is the entire purpose. The underscore-free name
    /// would warn as dead code, but `#[allow(dead_code)]` on the field is more
    /// honest than renaming it, because the field name is what a reader needs
    /// to understand the type.
    #[allow(dead_code)]
    file: File,
    path: PathBuf,
}

impl StateDirLock {
    /// The file the lock is held on. For diagnostics and tests.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Why the lock could not be taken. Each variant maps to a distinct stable code
/// so an operator can tell "someone else is running" from "this platform is not
/// supported" from "the filesystem refused".
#[derive(Debug)]
pub enum LockError {
    /// Another process holds the lock. `EWOULDBLOCK`.
    InUse { path: PathBuf },
    /// The platform has no implementation here. Refused rather than degraded.
    Unsupported { platform: &'static str },
    /// `open` or `flock` failed for any other reason. Carries the errno so the
    /// message can name it instead of saying "an error occurred".
    Failed {
        path: PathBuf,
        operation: &'static str,
        errno: i32,
    },
}

impl LockError {
    /// The stable code that appears at the front of the operator-facing message.
    pub fn code(&self) -> &'static str {
        match self {
            LockError::InUse { .. } => "NODE_STATE_DIR_IN_USE",
            LockError::Unsupported { .. } => "NODE_STATE_LOCK_UNSUPPORTED",
            LockError::Failed { .. } => "NODE_STATE_LOCK_FAILED",
        }
    }
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::InUse { path } => write!(
                f,
                "{}: another Node process holds the lock on {}. Two Nodes sharing one \
                 state directory overwrite each other's Kernel identity and consider each \
                 other's containers their own; stop the running Node first. The lock is \
                 released by the kernel when that process exits",
                self.code(),
                path.display()
            ),
            LockError::Unsupported { platform } => write!(
                f,
                "{}: the single-instance lock is implemented with flock(2) on Linux and \
                 macOS only; this build targets {platform}. Refusing to start rather than \
                 running without the guarantee: two Nodes on one state directory corrupt \
                 each other's identity",
                self.code()
            ),
            LockError::Failed {
                path,
                operation,
                errno,
            } => write!(
                f,
                "{}: {} failed for {} with errno {} ({}). The state directory cannot be \
                 locked, so this process cannot prove it is the only one using it",
                self.code(),
                operation,
                path.display(),
                errno,
                describe_errno(*errno)
            ),
        }
    }
}

impl std::error::Error for LockError {}

fn describe_errno(errno: i32) -> &'static str {
    match errno {
        libc::EWOULDBLOCK => "EWOULDBLOCK",
        libc::EINTR => "EINTR",
        libc::ENOLCK => "ENOLCK",
        libc::EBADF => "EBADF",
        libc::EACCES => "EACCES",
        libc::EPERM => "EPERM",
        libc::EROFS => "EROFS",
        _ => "see errno(3)",
    }
}

/// Take the exclusive lock on `state_dir`, or explain why not.
///
/// `state_dir` must already exist: `create_dir_all` runs before this in
/// `main`, because the lock file lives inside it.
///
/// The returned value must be held for the whole process. See [`StateDirLock`].
pub fn lock_state_dir(state_dir: &Path) -> Result<StateDirLock, LockError> {
    let path = state_dir.join(LOCK_FILE);
    platform::acquire(&path)
}

/// Errors that must NOT be reported as "another process is running".
///
/// `EINTR` is a signal interrupting the call, not contention: treating it as
/// "in use" would disguise a restart storm as a configuration error. It is
/// retried a bounded number of times and then reported as `NODE_STATE_LOCK_FAILED`.
/// `ENOLCK` means the filesystem does not implement locks at all; degrading to
/// "run anyway" there would remove the guarantee silently.
const EINTR_RETRIES: usize = 8;

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod platform {
    use super::{LockError, StateDirLock, EINTR_RETRIES};
    use std::fs::OpenOptions;
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::io::AsRawFd;
    use std::path::Path;

    pub(super) fn acquire(path: &Path) -> Result<StateDirLock, LockError> {
        // `mode(0o600)`: the lock file carries no data, but it sits next to the
        // identity files and there is no reason for it to be group- or
        // world-readable. `create(true)` without `truncate`: the file is a
        // handle, not content - truncating it would be harmless for `flock`
        // but would also rewrite a file another process may have open.
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(path)
            .map_err(|error| LockError::Failed {
                path: path.to_path_buf(),
                operation: "open the lock file",
                errno: error.raw_os_error().unwrap_or(0),
            })?;

        let fd = file.as_raw_fd();
        let mut attempt = 0;
        loop {
            // SAFETY: `fd` is a valid descriptor owned by `file` for the whole
            // call; `LOCK_EX | LOCK_NB` is a constant combination documented by
            // flock(2). No pointer or length is involved.
            let rc = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };
            if rc == 0 {
                return Ok(StateDirLock {
                    file,
                    path: path.to_path_buf(),
                });
            }
            let errno = std::io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or_default();
            match errno {
                libc::EWOULDBLOCK => {
                    return Err(LockError::InUse {
                        path: path.to_path_buf(),
                    })
                }
                libc::EINTR if attempt < EINTR_RETRIES => {
                    attempt += 1;
                    continue;
                }
                _ => {
                    return Err(LockError::Failed {
                        path: path.to_path_buf(),
                        operation: "flock(LOCK_EX|LOCK_NB)",
                        errno,
                    })
                }
            }
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod platform {
    use super::{LockError, StateDirLock};
    use std::path::Path;

    pub(super) fn acquire(path: &Path) -> Result<StateDirLock, LockError> {
        // Deliberately not `cfg(unix)`: FreeBSD, Solaris and illumos also have
        // `flock`, but this repository has never run its tests there, and a
        // lock whose semantics are assumed is worse than a refusal.
        let _ = path;
        Err(LockError::Unsupported {
            platform: std::env::consts::OS,
        })
    }
}

/// Read-only facts about the lock for tests and diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LockFacts {
    /// Device and inode of the lock file, as the filesystem reports them.
    pub device: u64,
    pub inode: u64,
}

/// Device and inode of the lock file, or `None` if it does not exist.
///
/// The tests use this to prove that the lock follows the inode: after an
/// in-place `mv` the pair is unchanged, and after `rm -rf` + `mkdir` it differs.
pub fn lock_facts(state_dir: &Path) -> Option<LockFacts> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = std::fs::metadata(state_dir.join(LOCK_FILE)).ok()?;
        Some(LockFacts {
            device: meta.dev(),
            inode: meta.ino(),
        })
    }
    #[cfg(not(unix))]
    {
        let _ = state_dir;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let base =
            std::env::temp_dir().join(format!("opsweave-lock-unit-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("create temp dir");
        base
    }

    #[test]
    fn the_lock_file_is_dot_prefixed_and_inside_the_state_dir() {
        // The CI harness clears state with `rm -rf "$STATE"/node-a/*`, which
        // does not match dotfiles. The lock must therefore be a dotfile, or
        // that step would delete it and the next run would create a new inode.
        assert_eq!(LOCK_FILE, ".node.lock");
        assert!(!LOCK_FILE.contains('/'));
    }

    #[test]
    fn every_error_code_is_distinct() {
        let in_use = LockError::InUse {
            path: PathBuf::from("/x"),
        };
        let unsupported = LockError::Unsupported {
            platform: "windows",
        };
        let failed = LockError::Failed {
            path: PathBuf::from("/x"),
            operation: "open",
            errno: 0,
        };
        let codes = [in_use.code(), unsupported.code(), failed.code()];
        assert_eq!(
            codes,
            [
                "NODE_STATE_DIR_IN_USE",
                "NODE_STATE_LOCK_UNSUPPORTED",
                "NODE_STATE_LOCK_FAILED",
            ]
        );
        assert_eq!(
            codes
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            3
        );
    }

    #[test]
    fn eintr_is_not_reported_as_in_use() {
        // A restart storm interrupted by signals must not look like a
        // configuration mistake. Only EWOULDBLOCK maps to InUse.
        let in_use = LockError::InUse {
            path: PathBuf::from("/x"),
        };
        let eintr = LockError::Failed {
            path: PathBuf::from("/x"),
            operation: "flock(LOCK_EX|LOCK_NB)",
            errno: libc::EINTR,
        };
        assert_ne!(in_use.code(), eintr.code());
        assert!(eintr.to_string().contains("EINTR"));
    }

    #[test]
    fn the_in_use_message_tells_the_operator_what_to_do() {
        let message = LockError::InUse {
            path: PathBuf::from("/srv/node/.node.lock"),
        }
        .to_string();
        assert!(message.starts_with("NODE_STATE_DIR_IN_USE:"));
        assert!(message.contains("stop the running Node first"));
        // It must not claim the lock survives a crash: the kernel releases it.
        assert!(message.contains("released by the kernel"));
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn the_same_process_cannot_take_the_lock_twice() {
        // `flock` is per open file description, so a second open in the SAME
        // process must still fail - this is why the lock cannot be "re-entered"
        // by a re-initialisation path.
        let dir = tmpdir("twice");
        let first = lock_state_dir(&dir).expect("first lock");
        let second = lock_state_dir(&dir);
        match second {
            Err(LockError::InUse { .. }) => {}
            other => panic!("second lock must report InUse, got {other:?}"),
        }
        drop(first);
        // Bound, not discarded: the point of this line is that the lock can be
        // taken, and `#[must_use]` exists so nobody writes `let _ =` in the
        // product path by accident.
        let regained = lock_state_dir(&dir).expect("after dropping the first, the lock is free");
        drop(regained);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn the_lock_follows_the_inode_and_not_the_path() {
        let dir = tmpdir("inode");
        let held = lock_state_dir(&dir).expect("lock");
        let before = lock_facts(&dir).expect("lock file exists");

        // Delete and re-create at the SAME path: a new inode, so a second
        // locker succeeds. This is the documented limit (Gate §4.1), asserted
        // here so nobody later "fixes" it by assuming the path is enough.
        drop(held);
        std::fs::remove_dir_all(&dir).expect("remove");
        std::fs::create_dir_all(&dir).expect("recreate");
        let held_again = lock_state_dir(&dir).expect("lock the new inode");
        let after = lock_facts(&dir).expect("lock file exists");
        assert_ne!(
            (before.device, before.inode),
            (after.device, after.inode),
            "re-creating the directory must be visible as a different inode"
        );
        drop(held_again);
        std::fs::remove_dir_all(&dir).ok();
    }
}
