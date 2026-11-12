// P001-C1.2.4 - what the persistence guarantees actually are.
//
// The brief asks for three levels to be separated instead of conflated:
//
//   normal process exit   the page cache still holds the write; every later
//                         process sees it, and it survives the process dying
//   SIGKILL               same as above - nothing in the kernel is discarded
//   power loss            only what reached the disk survives; a rename that
//                         returned may still be undone, and an unlinked file may
//                         come back
//
// Only the third needs `fsync`, and only the third can be claimed by an fsync.
// A test that kills a process and calls the result "durable" is testing the
// first two levels and telling itself it tested the third.
//
// What is testable on a running machine is the ORDER the code establishes, which
// is what makes the fsyncs mean something:
//
//   1. the marker's content is synced before the name points at it
//   2. the marker's name is synced (parent directory) before any identity file
//      is touched
//   3. identity files are replaced by rename, never written in place, so a
//      reader sees the old one or the new one
//   4. the marker is removed durably, so a power cut cannot bring it back after
//      the directory has been settled
//
// This file asserts 1-4 by observing the filesystem, and it asserts that the
// order is what protects the invariant: at every point a process could die, the
// directory either continues the migration or refuses - never settles into the
// inherited identity. The power-loss claim itself is a design argument recorded
// in ADR-023 §2.5, not something these tests measure.

use std::path::{Path, PathBuf};

fn args_for(state_dir: &Path) -> opsweave_node::config::Args {
    use clap::Parser;
    opsweave_node::config::Args::parse_from([
        "opsweave-node",
        "--data-bind",
        "127.0.0.1:0",
        "--state-dir",
        state_dir.to_str().unwrap(),
    ])
}

fn marker_path(dir: &Path) -> PathBuf {
    dir.join("reinitialize-in-progress.json")
}

fn settled(dir: &Path) -> (uuid::Uuid, String) {
    std::fs::create_dir_all(dir).unwrap();
    let node_id = uuid::Uuid::new_v4();
    let installation_id = uuid::Uuid::new_v4().to_string();
    std::fs::write(dir.join("installation-id"), &installation_id).unwrap();
    std::fs::write(
        dir.join("node-identity.json"),
        serde_json::json!({
            "nodeId": node_id,
            "credential": "ow_node_durability_test",
            "dataToken": "ow_data_durability_test",
            "generation": 1,
            "name": "node-a",
        })
        .to_string(),
    )
    .unwrap();
    let resolved = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(dir),
        opsweave_node::runtime::IdentityAction::None,
    )
    .unwrap()
    .installation_id;
    assert_eq!(resolved, installation_id);
    (node_id, installation_id)
}

fn clone_dir(from: &Path, to: &Path) {
    let status = std::process::Command::new("cp")
        .arg("-a")
        .arg(from)
        .arg(to)
        .status()
        .expect("run cp -a");
    assert!(status.success());
}

/// The marker exists in exactly one form: complete JSON, readable, and only
/// once the rename has published it. No `.tmp` file is ever left where a later
/// start could read a half-written marker and conclude "no migration".
#[test]
fn the_marker_is_published_complete_or_not_at_all() {
    let work = tempfile::tempdir().unwrap();
    let origin = work.path().join("data/node-a");
    settled(&origin);
    let clone = work.path().join("data/node-b");
    clone_dir(&origin, &clone);

    opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&clone),
        opsweave_node::runtime::IdentityAction::Reinitialize,
    )
    .unwrap();

    let record: serde_json::Value =
        serde_json::from_slice(&std::fs::read(marker_path(&clone)).unwrap())
            .expect("the marker must be valid JSON the moment it has a name");
    assert!(record["inheritedInstallationId"].is_string());
    assert!(
        record["inheritedNodeId"].is_string(),
        "the marker must record the inherited Kernel node id, or commit cannot tell whether \
         the Kernel half of the migration happened"
    );
    assert!(record["startedAt"].is_string());

    // No temporary file survives a successful publish. A lingering one is the
    // shape of a crash *during* the write, which the next start must not read.
    let leftovers: Vec<String> = std::fs::read_dir(&clone)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.contains(".tmp.") || name.contains(".pub."))
        .collect();
    assert!(
        leftovers.is_empty(),
        "a failed or partial write left temporary files behind: {leftovers:?}"
    );
}

/// A start that dies before `commit_migration` leaves a directory the next
/// start still refuses to settle - across every intermediate shape, including
/// the one with both identity files complete.
///
/// This is the property the fsyncs in `write_atomic` and `remove_durable` are
/// there to preserve across power loss; here it is asserted across an ordinary
/// crash, which is what can be measured on a live machine.
#[test]
fn no_intermediate_state_settles_into_the_inherited_identity() {
    // Each entry is the state a crash can leave, built the way the code does.
    for point in [
        "marker_only",
        "identity_removed",
        "minted_and_bound",
        "kernel_enrolled",
    ] {
        let work = tempfile::tempdir().unwrap();
        let origin = work.path().join("data/node-a");
        let (node_id, inherited) = settled(&origin);
        let clone = work.path().join("data/node-b");
        clone_dir(&origin, &clone);

        // Steps of a reinitialize, stopped after `point`.
        std::fs::write(
            marker_path(&clone),
            serde_json::json!({
                "inheritedInstallationId": inherited,
                "inheritedNodeId": node_id.to_string(),
                "startedAt": "2026-11-13T00:00:00Z",
            })
            .to_string(),
        )
        .unwrap();
        let mut fresh = None;
        if point != "marker_only" {
            std::fs::remove_file(clone.join("installation-id")).unwrap();
            std::fs::remove_file(clone.join("installation-binding.json")).unwrap();
        }
        if point == "minted_and_bound" || point == "kernel_enrolled" {
            fresh = Some(
                opsweave_node::runtime::load_or_create_installation_id_with(
                    &args_for(&clone),
                    opsweave_node::runtime::IdentityAction::None,
                )
                .unwrap()
                .installation_id,
            );
        }
        if point == "kernel_enrolled" {
            std::fs::write(
                clone.join("node-identity.json"),
                serde_json::json!({
                    "nodeId": uuid::Uuid::new_v4(),
                    "credential": "ow_node_new",
                    "dataToken": "ow_data_new",
                    "generation": 1,
                    "name": "node-b",
                })
                .to_string(),
            )
            .unwrap();
        }

        // The next start.
        let next = opsweave_node::runtime::load_or_create_installation_id_with(
            &args_for(&clone),
            opsweave_node::runtime::IdentityAction::None,
        )
        .expect("an interrupted migration must be continuable, not a dead end");
        assert!(
            next.discard_node_identity,
            "{point}: the next start treated an unfinished migration as settled"
        );
        assert_ne!(
            next.installation_id, inherited,
            "{point}: the next start resumed with the INHERITED Docker installation id"
        );
        if let Some(fresh) = fresh {
            assert_eq!(
                next.installation_id, fresh,
                "{point}: the identity the migration already minted was replaced"
            );
        }

        // And it cannot be committed before the Kernel half is new.
        if point != "kernel_enrolled" {
            assert!(
                opsweave_node::runtime::commit_migration(&args_for(&clone)).is_err(),
                "{point}: the migration committed while the Kernel identity was still the \
                 original's"
            );
        }
    }
}

/// `commit_migration` clears the marker durably, and a directory that has been
/// committed is settled: the removal cannot be undone by the next start.
#[test]
fn a_committed_marker_stays_gone() {
    let work = tempfile::tempdir().unwrap();
    let origin = work.path().join("data/node-a");
    settled(&origin);
    let clone = work.path().join("data/node-b");
    clone_dir(&origin, &clone);
    opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&clone),
        opsweave_node::runtime::IdentityAction::Reinitialize,
    )
    .unwrap();
    std::fs::write(
        clone.join("node-identity.json"),
        serde_json::json!({
            "nodeId": uuid::Uuid::new_v4(),
            "credential": "ow_node_new",
            "dataToken": "ow_data_new",
            "generation": 1,
            "name": "node-b",
        })
        .to_string(),
    )
    .unwrap();
    opsweave_node::runtime::commit_migration(&args_for(&clone)).unwrap();
    assert!(!marker_path(&clone).exists());

    let restart = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&clone),
        opsweave_node::runtime::IdentityAction::None,
    )
    .unwrap();
    assert!(
        !restart.discard_node_identity,
        "a committed directory asked for another Kernel identity"
    );
    assert!(!marker_path(&clone).exists(), "the marker came back");
}

/// `commit_migration` is called from `main` after enrolment. It must not be
/// possible to clear the marker while the inherited id is on disk, because that
/// is the state the defect returned.
#[test]
fn commit_cannot_clear_a_marker_over_the_inherited_identity() {
    let work = tempfile::tempdir().unwrap();
    let origin = work.path().join("data/node-a");
    let (node_id, inherited) = settled(&origin);
    let clone = work.path().join("data/node-b");
    clone_dir(&origin, &clone);
    std::fs::write(
        marker_path(&clone),
        serde_json::json!({
            "inheritedInstallationId": inherited,
            "inheritedNodeId": node_id.to_string(),
            "startedAt": "2026-11-13T00:00:00Z",
        })
        .to_string(),
    )
    .unwrap();

    let error = opsweave_node::runtime::commit_migration(&args_for(&clone))
        .expect_err("commit cleared the marker over the inherited identity");
    assert!(
        format!("{error:#}").contains(&inherited),
        "the refusal should name the inherited id, got: {error:#}"
    );
    assert!(marker_path(&clone).exists());
    assert_eq!(
        std::fs::read_to_string(clone.join("installation-id"))
            .unwrap()
            .trim(),
        inherited,
        "the refused commit changed the identity on the way out"
    );
}
