// P001-C1.2.1 Task A - a *full clone* of a Node state directory.
//
// P001-C1.2 gave every installation an `opsweave.installation-id` in its state
// directory and used it as the ownership token. That is correct for two
// installations that were created independently. It is **not** correct for two
// installations where one is a byte-for-byte copy of the other's state
// directory: the copy inherits `node-identity.json` (same node id) *and*
// `installation-id` (same ownership token), so every ownership question the
// clone asks is answered "yes".
//
// This is the reproduction, and it is deliberately written to fail against the
// C1.2 code. It must be run against a real daemon because the question is what
// the daemon does to a container, not what a function returns.
//
// Distinct lifecycle events, which the rest of this file keeps separate:
//
//   restart           same state dir, same process identity. Identity MUST persist.
//   backup/restore    a copy of the data, restored into a *new* place. The restored
//                     copy and the original both exist; they are two installations.
//   full clone        `cp -a state_dir state_dir2`. Identical node-id AND
//                     installation-id. Indistinguishable from a restore by content
//                     alone - only the daemon can tell them apart.
//   in-place migration state moved, original gone. Identity MUST persist.
use opsweave_node::docker::{container_name, DockerAdapter, Ownership};
use std::path::{Path, PathBuf};

const REQUIRE_DOCKER_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DOCKER";

fn docker_required() -> bool {
    match std::env::var(REQUIRE_DOCKER_ENV) {
        Err(std::env::VarError::NotPresent) => false,
        Err(std::env::VarError::NotUnicode(_)) => {
            panic!("{REQUIRE_DOCKER_ENV} is set but is not valid UTF-8")
        }
        Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
            "" | "0" | "false" | "no" => false,
            "1" | "true" | "yes" => true,
            other => panic!("{REQUIRE_DOCKER_ENV} is set to {other:?}: use 1 to require it"),
        },
    }
}

fn docker_host() -> String {
    std::env::var("OPSWEAVE_DOCKER_HOST").unwrap_or_else(|_| "unix:///var/run/docker.sock".into())
}

fn docker(args: &[&str]) -> String {
    let output = std::process::Command::new("docker")
        .args(args)
        .env("DOCKER_HOST", docker_host())
        .output()
        .expect("run docker");
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

async fn adapter_or_skip(installation_id: &str) -> Option<DockerAdapter> {
    let adapter = DockerAdapter::new("docker".to_string(), docker_host())
        .with_installation_id(installation_id);
    match adapter.version().await {
        Ok(_) => Some(adapter),
        Err(error) => {
            if docker_required() {
                panic!("{REQUIRE_DOCKER_ENV} is set but Docker is unavailable: {error:#}");
            }
            eprintln!("skip: Docker unavailable ({error:#}) and {REQUIRE_DOCKER_ENV} is not 1");
            None
        }
    }
}

fn run_labelled(name: &str, node_id: uuid::Uuid, labels: &[(&str, &str)]) {
    let _ = docker(&["rm", "-f", name]);
    let mut args: Vec<String> = vec![
        "run".into(),
        "-d".into(),
        "--name".into(),
        name.into(),
        "--label".into(),
        "opsweave.managed=true".into(),
        "--label".into(),
        format!("opsweave.node-id={node_id}"),
    ];
    for (key, value) in labels {
        args.push("--label".into());
        args.push(format!("{key}={value}"));
    }
    for tail in ["alpine:3", "sh", "-c", "while true; do sleep 5; done"] {
        args.push(tail.into());
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    docker(&refs);
}

fn inspect(name: &str, format: &str) -> String {
    docker(&["inspect", "-f", format, name])
}

/// Copy a state directory the way an operator would: `cp -a`, preserving every
/// file including the two identity files.
fn clone_state_dir(from: &Path, to: &Path) {
    // `cp -a src dst` copies *into* dst when dst exists; these tests want the
    // contents of `from` to appear *as* `to`, and `to`'s parent to exist.
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    let status = std::process::Command::new("cp")
        .arg("-a")
        .arg(from)
        .arg(to)
        .status()
        .expect("run cp -a");
    assert!(
        status.success(),
        "cp -a {} {}",
        from.display(),
        to.display()
    );
    assert!(
        to.join("installation-id").exists(),
        "the clone must carry the identity file"
    );
}

/// Write the two files a Node's state directory carries after it has enrolled.
fn seed_state_dir(dir: &Path, node_id: uuid::Uuid, installation_id: &str) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("installation-id"), installation_id).unwrap();
    std::fs::write(
        dir.join("node-identity.json"),
        serde_json::json!({
            "nodeId": node_id,
            "credential": "ow_node_clone_test",
            "dataToken": "ow_data_clone_test",
            "generation": 1,
            "name": "node-a",
        })
        .to_string(),
    )
    .unwrap();
    dir.to_path_buf()
}

/// Build `Args` for a state directory without starting anything.
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

/// THE REPRODUCTION.
///
/// A and B are two state directories where B is a full `cp -a` clone of A.
/// Before C1.2.1 both resolve to the same ownership token, so B answers `Ours`
/// for A's container and its sweep lists it. That is the bug.
///
/// After C1.2.1, B's start refuses with INSTALLATION_IDENTITY_CONFLICT unless
/// the operator says what the directory is; and if they say `reinitialize`, B
/// gets a token of its own and cannot reach A's container.
#[tokio::test]
async fn a_full_state_dir_clone_cannot_claim_the_original_installation() {
    let installation_a = uuid::Uuid::new_v4().to_string();
    let node_id = uuid::Uuid::new_v4();
    let work = tempfile::tempdir().unwrap();
    let state_a = seed_state_dir(&work.path().join("data/node-a"), node_id, &installation_a);

    // A's identity resolves normally and is now bound to A's directory.
    let token_a = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&state_a),
        opsweave_node::runtime::IdentityAction::None,
    )
    .expect("A's own state directory must resolve")
    .installation_id;
    assert_eq!(
        token_a, installation_a,
        "A must keep the id it was seeded with"
    );

    // B is a byte-for-byte copy, taken AFTER A recorded its binding.
    let state_b = work.path().join("data/node-b");
    clone_state_dir(&state_a, &state_b);
    assert_eq!(
        std::fs::read_to_string(state_b.join("installation-id")).unwrap(),
        installation_a,
        "the clone inherits the identity file"
    );

    // Without a decision, B must refuse. This is the fail-closed gate.
    let refused = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&state_b),
        opsweave_node::runtime::IdentityAction::None,
    );
    let refused = refused.expect_err(
        "a full clone resolved silently: two installations now share one ownership token, \
         so either can delete the other's containers",
    );
    let text = format!("{refused:#}");
    assert!(
        text.contains("INSTALLATION_IDENTITY_CONFLICT"),
        "the refusal must be diagnosable, got: {text}"
    );
    assert!(
        text.contains("reinitialize") && text.contains("accept"),
        "the refusal must tell the operator both ways forward, got: {text}"
    );

    // A must be unaffected by B's failed start.
    assert_eq!(
        opsweave_node::runtime::load_or_create_installation_id_with(
            &args_for(&state_a),
            opsweave_node::runtime::IdentityAction::None,
        )
        .unwrap()
        .installation_id,
        token_a,
        "B's refusal must not disturb A's identity"
    );

    // The operator decides B is a clone. It gets its own identity.
    let reinit = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&state_b),
        opsweave_node::runtime::IdentityAction::Reinitialize,
    )
    .expect("reinitialize must succeed");
    let token_b = reinit.installation_id;
    // The Kernel identity is the other half, and C1.2.1 left it shared.
    assert!(
        reinit.discard_node_identity,
        "reinitialize must also discard the inherited Kernel node identity"
    );
    assert_ne!(
        token_b, token_a,
        "after reinitialize the clone must not keep the original's token"
    );

    // Now the daemon-level assertion: with distinct tokens, B cannot reach A's
    // container. This is the property that matters - the identity split is only
    // worth anything if Docker agrees.
    let node_b: String = serde_json::from_str::<serde_json::Value>(
        &std::fs::read_to_string(state_b.join("node-identity.json")).unwrap(),
    )
    .unwrap()["nodeId"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        node_b,
        node_id.to_string(),
        "the clone still shares the node id"
    );

    let Some(adapter_b) = adapter_or_skip(&token_b).await else {
        return;
    };
    let instance_id = uuid::Uuid::new_v4();
    let name = container_name(node_id, instance_id);
    run_labelled(&name, node_id, &[("opsweave.installation-id", &token_a)]);
    let before_id = inspect(&name, "{{.Id}}");
    assert!(!before_id.is_empty(), "A's container did not start");

    assert_eq!(
        adapter_b.ownership_of(&name).await.unwrap(),
        Ownership::Foreign,
        "the clone claimed A's container after being given its own identity"
    );
    let swept = adapter_b.list_managed(node_id).await.unwrap();
    assert!(
        !swept.contains(&name),
        "the clone's sweep listed A's container: {swept:?}"
    );

    let _ = docker(&["rm", "-f", &name]);
}

/// A restart must NOT be mistaken for a clone. Same directory, same inode: the
/// identity is stable across restarts, which is the entire reason it is not
/// re-minted every start.
#[test]
fn a_restart_keeps_its_identity() {
    let work = tempfile::tempdir().unwrap();
    let state = seed_state_dir(
        &work.path().join("data/node-a"),
        uuid::Uuid::new_v4(),
        &uuid::Uuid::new_v4().to_string(),
    );
    let first = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&state),
        opsweave_node::runtime::IdentityAction::None,
    )
    .unwrap()
    .installation_id;
    for _ in 0..3 {
        assert_eq!(
            opsweave_node::runtime::load_or_create_installation_id_with(
                &args_for(&state),
                opsweave_node::runtime::IdentityAction::None,
            )
            .unwrap()
            .installation_id,
            first,
            "a restart re-minted the identity, which would orphan its own containers"
        );
    }
}

/// An in-place `mv` on one filesystem preserves the inode, so the identity
/// survives. This is the event that would break if the binding keyed on path.
#[test]
fn an_in_place_move_keeps_its_identity() {
    let work = tempfile::tempdir().unwrap();
    let from = seed_state_dir(
        &work.path().join("data/node-a"),
        uuid::Uuid::new_v4(),
        &uuid::Uuid::new_v4().to_string(),
    );
    let first = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&from),
        opsweave_node::runtime::IdentityAction::None,
    )
    .unwrap()
    .installation_id;
    let to = work.path().join("data/moved");
    std::fs::rename(&from, &to).unwrap();
    assert_eq!(
        opsweave_node::runtime::load_or_create_installation_id_with(
            &args_for(&to),
            opsweave_node::runtime::IdentityAction::None,
        )
        .expect("an in-place move must not be treated as a clone")
        .installation_id,
        first
    );
}

/// A restore into a new directory is the same on-disk bytes as a clone, so it
/// trips the same gate - and `accept` is how the operator says "this is the
/// original, put somewhere else".
#[test]
fn a_restore_into_a_new_directory_needs_an_explicit_accept() {
    let work = tempfile::tempdir().unwrap();
    let original = seed_state_dir(
        &work.path().join("data/node-a"),
        uuid::Uuid::new_v4(),
        &uuid::Uuid::new_v4().to_string(),
    );
    let token = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&original),
        opsweave_node::runtime::IdentityAction::None,
    )
    .unwrap()
    .installation_id;
    let restored = work.path().join("restore/node-a");
    clone_state_dir(&original, &restored);

    assert!(
        opsweave_node::runtime::load_or_create_installation_id_with(
            &args_for(&restored),
            opsweave_node::runtime::IdentityAction::None,
        )
        .is_err(),
        "a restore must not be silently assumed to be the original"
    );
    assert_eq!(
        opsweave_node::runtime::load_or_create_installation_id_with(
            &args_for(&restored),
            opsweave_node::runtime::IdentityAction::Accept,
        )
        .unwrap()
        .installation_id,
        token,
        "accept must keep the identity"
    );
    // And it stays accepted across a restart.
    assert_eq!(
        opsweave_node::runtime::load_or_create_installation_id_with(
            &args_for(&restored),
            opsweave_node::runtime::IdentityAction::None,
        )
        .unwrap()
        .installation_id,
        token
    );
}

/// The mint must be safe against two Nodes racing. Exactly one identity must
/// exist afterwards, and both callers must agree on it - the previous
/// implementation returned the loser's unused id.
#[test]
fn concurrent_mints_agree_on_one_identity() {
    let work = tempfile::tempdir().unwrap();
    let state = work.path().join("data/node-a");
    std::fs::create_dir_all(&state).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let mut handles = Vec::new();
    for _ in 0..8 {
        let state = state.clone();
        let barrier = barrier.clone();
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            opsweave_node::runtime::load_or_create_installation_id_with(
                &args_for(&state),
                opsweave_node::runtime::IdentityAction::None,
            )
            .unwrap()
            .installation_id
        }));
    }
    let ids: std::collections::BTreeSet<String> =
        handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(
        ids.len(),
        1,
        "concurrent starts disagreed about the installation identity: {ids:?}"
    );
    assert_eq!(
        std::fs::read_to_string(state.join("installation-id"))
            .unwrap()
            .trim(),
        ids.iter().next().unwrap(),
        "the identity on disk is not the one the processes reported"
    );
}

/// An unreadable identity file is not "no identity". Treating it as absent
/// minted a second one and orphaned everything the first owned.
#[test]
#[cfg(unix)]
fn an_unreadable_identity_file_is_an_error_not_a_new_identity() {
    use std::os::unix::fs::PermissionsExt;
    let work = tempfile::tempdir().unwrap();
    let state = seed_state_dir(
        &work.path().join("data/node-a"),
        uuid::Uuid::new_v4(),
        &uuid::Uuid::new_v4().to_string(),
    );
    let path = state.join("installation-id");
    // A directory where the file should be: readable-as-a-path but not as a
    // file, and not "NotFound" either. Running as root would bypass a mode
    // check, so this uses a shape that fails for every user.
    let _ = std::fs::remove_file(&path);
    std::fs::create_dir(&path).unwrap();
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    let error = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&state),
        opsweave_node::runtime::IdentityAction::None,
    )
    .expect_err("an unreadable identity must not be replaced by a fresh one");
    assert!(
        format!("{error:#}").contains("cannot read"),
        "unexpected error: {error:#}"
    );
    assert!(
        path.is_dir(),
        "the unreadable path was replaced, which is exactly the silent re-mint"
    );
}

/// A failed re-enrolment must leave the directory exactly as it was.
///
/// `reinitialize` sets the inherited Kernel identity aside before enrolling, so
/// a network failure or a rejected token could otherwise destroy a working
/// installation. ADR-023 §2.2a requires the old files to be restorable, and the
/// node must never fall back to the shared credential.
#[test]
fn setting_aside_and_restoring_a_kernel_identity_is_lossless() {
    let work = tempfile::tempdir().unwrap();
    let state = seed_state_dir(
        &work.path().join("data/node-a"),
        uuid::Uuid::new_v4(),
        &uuid::Uuid::new_v4().to_string(),
    );
    let before = std::fs::read(state.join("node-identity.json")).unwrap();

    let previous = opsweave_node::runtime::set_aside_node_identity(&args_for(&state))
        .expect("setting aside must succeed");
    assert!(
        !state.join("node-identity.json").exists(),
        "the inherited identity must be moved out of the way before enrolling"
    );
    let previous = previous.expect("there was an identity to set aside");

    opsweave_node::runtime::restore_node_identity(&args_for(&state), &previous);
    assert_eq!(
        std::fs::read(state.join("node-identity.json")).unwrap(),
        before,
        "a failed re-enrolment must restore the previous identity byte for byte"
    );

    // With nothing there, setting aside is a normal first-run no-op.
    let empty = tempfile::tempdir().unwrap();
    let empty_state = empty.path().join("data/node-c");
    std::fs::create_dir_all(&empty_state).unwrap();
    assert!(
        opsweave_node::runtime::set_aside_node_identity(&args_for(&empty_state))
            .unwrap()
            .is_none(),
        "a directory with no identity is not an error"
    );
}

// ---- P001-C1.2.3: a failed reinitialize must not settle into a usable state --
//
// The first implementation restored only `node-identity.json` when enrolment
// failed. The new `installation-id` and binding stayed, so the next start found
// a binding that matched its own directory, concluded the directory was
// settled, and loaded the ORIGINAL's Kernel identity. Measured before the fix:
// a failed reinitialize followed by a plain restart rewrote node A's data
// endpoint.

fn write_marker(dir: &Path, inherited: &str) {
    std::fs::write(
        dir.join("reinitialize-in-progress.json"),
        serde_json::json!({
            "inheritedInstallationId": inherited,
            "startedAt": "2026-11-12T00:00:00Z",
        })
        .to_string(),
    )
    .unwrap();
}

/// Force this directory to look like a clone: a binding that names a different
/// directory, which is what `cp -a` produces.
#[cfg(unix)]
fn make_it_a_clone(state: &Path, installation_id: &str) {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(state).unwrap();
    std::fs::write(
        state.join("installation-binding.json"),
        serde_json::json!({
            "installationId": installation_id,
            "stateDirDevice": meta.dev(),
            "stateDirInode": meta.ino() + 1,
            "recordedAt": "2026-11-12T00:00:00Z",
        })
        .to_string(),
    )
    .unwrap();
}

/// The exact sequence the defect needs: reinitialize, fail, start again with no
/// token and no repair.
#[test]
fn a_failed_reinitialize_is_not_settled_on_the_next_start() {
    let work = tempfile::tempdir().unwrap();
    let state = seed_state_dir(
        &work.path().join("data/node-a"),
        uuid::Uuid::new_v4(),
        &uuid::Uuid::new_v4().to_string(),
    );
    let inherited = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&state),
        opsweave_node::runtime::IdentityAction::None,
    )
    .unwrap()
    .installation_id;
    make_it_a_clone(&state, &inherited);

    let first = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&state),
        opsweave_node::runtime::IdentityAction::Reinitialize,
    )
    .unwrap();
    assert!(first.discard_node_identity);
    assert_ne!(first.installation_id, inherited, "a new id must be minted");
    assert!(
        opsweave_node::runtime::pending_migration(&args_for(&state))
            .unwrap()
            .is_some(),
        "the reinitialize must leave a durable marker until it is committed"
    );

    // Second start, same directory, no repair, no token.
    let second = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&state),
        opsweave_node::runtime::IdentityAction::None,
    )
    .unwrap();
    assert!(
        second.discard_node_identity,
        "the second start treated a half-finished reinitialize as settled, which is \
         what let it load the original's Kernel identity"
    );
    assert_eq!(second.installation_id, first.installation_id);

    opsweave_node::runtime::commit_migration(&args_for(&state)).unwrap();
    assert!(opsweave_node::runtime::pending_migration(&args_for(&state))
        .unwrap()
        .is_none());
    let settled = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&state),
        opsweave_node::runtime::IdentityAction::None,
    )
    .unwrap();
    assert!(
        !settled.discard_node_identity,
        "a committed migration must not keep asking for a new Kernel identity"
    );
    assert_eq!(settled.installation_id, first.installation_id);
}

/// Every crash point leaves a state that either continues the migration or
/// refuses - never one that silently inherits.
#[cfg(unix)]
#[test]
fn every_crash_point_is_unsafe_to_settle() {
    for point in ["after_marker", "after_mint", "identity_missing"] {
        let work = tempfile::tempdir().unwrap();
        let state = seed_state_dir(
            &work.path().join("data/node-a"),
            uuid::Uuid::new_v4(),
            &uuid::Uuid::new_v4().to_string(),
        );
        let inherited = opsweave_node::runtime::load_or_create_installation_id_with(
            &args_for(&state),
            opsweave_node::runtime::IdentityAction::None,
        )
        .unwrap()
        .installation_id;

        match point {
            "after_marker" => write_marker(&state, &inherited),
            "after_mint" => {
                let fresh = uuid::Uuid::new_v4().to_string();
                std::fs::write(state.join("installation-id"), &fresh).unwrap();
                make_it_a_clone(&state, &fresh);
                write_marker(&state, &inherited);
            }
            _ => {
                std::fs::remove_file(state.join("installation-id")).unwrap();
                write_marker(&state, &inherited);
            }
        }

        match opsweave_node::runtime::load_or_create_installation_id_with(
            &args_for(&state),
            opsweave_node::runtime::IdentityAction::None,
        ) {
            Ok(identity) => assert!(
                identity.discard_node_identity,
                "crash point {point} was treated as settled: the node would load the \
                 inherited Kernel identity"
            ),
            Err(error) => {
                let text = format!("{error:#}");
                assert!(
                    text.contains("INSTALLATION_MIGRATION_IN_PROGRESS")
                        || text.contains("INSTALLATION_IDENTITY_CONFLICT"),
                    "crash point {point} failed without saying why: {text}"
                );
            }
        }
    }
}

/// `accept` and `reinitialize` must stay distinct.
#[test]
fn accept_and_reinitialize_do_not_mix() {
    let work = tempfile::tempdir().unwrap();
    let state = seed_state_dir(
        &work.path().join("data/node-a"),
        uuid::Uuid::new_v4(),
        &uuid::Uuid::new_v4().to_string(),
    );
    let inherited = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&state),
        opsweave_node::runtime::IdentityAction::None,
    )
    .unwrap()
    .installation_id;
    write_marker(&state, &inherited);

    let error = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&state),
        opsweave_node::runtime::IdentityAction::Accept,
    )
    .expect_err("accept must not silently resolve a pending reinitialize");
    assert!(
        format!("{error:#}").contains("INSTALLATION_MIGRATION_IN_PROGRESS"),
        "unexpected error: {error:#}"
    );
}
