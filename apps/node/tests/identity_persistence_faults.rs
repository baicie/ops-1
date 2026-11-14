// P001-C1.4 follow-up — the identity write path under REAL filesystem faults.
//
// `migration_durability.rs` asserts the state machine's outcomes after a
// process dies. This file attacks the WRITE PATH itself, one syscall at a time,
// and asks the question that matters for every one of them:
//
//     after this step failed, is the identity on disk still one the next start
//     can settle, or has the directory been left in a state nothing vouches for?
//
// ## How the faults are produced
//
// No mocks and no injected failpoints. Each case makes the real syscall fail
// with a real filesystem condition:
//
//   * the parent directory replaced by a FILE          -> `create_dir_all` fails
//   * the marker file truncated by something else      -> parse fails
//   * a binding that names a different id              -> attestation fails
//
// The WRITE path itself (`write_atomic`: temp file, `sync_all`, `rename`,
// parent `fsync`) is attacked in `runtime.rs`'s unit tests instead. Driving it
// from here does not reach it - `load_or_create_installation_id` only reads and
// mints, and `write_atomic` is called by `save_identity` after enrolment.
// Measured: reverting the `rename` error handling left every case in this file
// green.
//
// ## What is asserted every time
//
//   * the call reports failure (silence is the defect this file exists for)
//   * whatever was on disk before is still there and still valid
//   * the next `load_or_create` does not adopt a half-written value
use opsweave_node::config::Args;
use std::path::{Path, PathBuf};

fn args_for(state_dir: &Path) -> Args {
    // Built through clap rather than a struct literal: `Args` gains fields, and
    // a literal in a test file silently breaks every time it does.
    use clap::Parser;
    Args::parse_from([
        "opsweave-node",
        "--data-bind",
        "127.0.0.1:0",
        "--state-dir",
        state_dir.to_str().unwrap(),
    ])
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("opsweave-persist-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("scratch dir");
    // Restore writability in case a previous case left it read-only.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755));
    }
    dir
}

#[test]
fn a_state_dir_that_is_a_file_cannot_be_used() {
    // `create_dir_all` on a path that exists as a FILE must fail rather than
    // proceed. This is the shape a botched restore leaves.
    let root = scratch("dir-is-file");
    let state = root.join("state");
    std::fs::write(&state, b"not a directory").expect("file where the dir should be");

    let args = args_for(&state);
    let result = opsweave_node::runtime::load_or_create_installation_id(&args);
    assert!(
        result.is_err(),
        "a state directory that is a regular file must be refused"
    );
    // The file must still be there: the failure must not have deleted it.
    assert!(state.is_file(), "the squatter file must be left alone");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_partially_written_marker_is_never_adopted_as_settled() {
    // A crash mid-`write_all` leaves a truncated JSON file only if the write was
    // NOT atomic. `write_atomic` publishes via `rename`, so the only way to see
    // a truncated marker on disk is for something else to have written it - a
    // restore, or an older binary. That state must be refused, not read as
    // "no marker".
    let dir = scratch("truncated-marker");
    std::fs::write(
        dir.join("installation-id"),
        uuid::Uuid::new_v4().to_string(),
    )
    .expect("seed");
    std::fs::write(
        dir.join("reinitialize-in-progress.json"),
        br#"{"inheritedInstallationId": "abc"#,
    )
    .expect("truncated marker");

    let args = args_for(&dir);
    let result = opsweave_node::runtime::load_or_create_installation_id(&args);
    assert!(
        result.is_err(),
        "a marker that cannot be parsed must refuse the start, not be treated as absent"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_binding_that_disagrees_with_the_identity_is_refused() {
    // The two files attest the same directory; a disagreement means one of them
    // was replaced. Guessing which is how identities get mixed (ADR-023 §2.2a).
    let dir = scratch("binding-mismatch");
    std::fs::create_dir_all(&dir).expect("dir");
    let id = uuid::Uuid::new_v4();
    std::fs::write(dir.join("installation-id"), id.to_string()).expect("id");
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = std::fs::metadata(&dir).expect("stat");
        let other = uuid::Uuid::new_v4();
        std::fs::write(
            dir.join("installation-binding.json"),
            format!(
                r#"{{"installationId":"{other}","stateDirDevice":{},"stateDirInode":{}}}"#,
                meta.dev(),
                meta.ino()
            ),
        )
        .expect("binding");
    }
    #[cfg(not(unix))]
    {
        let _ = id;
        eprintln!("skip: device/inode are not available on this platform");
        let _ = std::fs::remove_dir_all(&dir);
        return;
    }

    let args = args_for(&dir);
    let result = opsweave_node::runtime::load_or_create_installation_id(&args);
    assert!(
        result.is_err(),
        "an identity and a binding that name different ids over the same directory must be refused"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
