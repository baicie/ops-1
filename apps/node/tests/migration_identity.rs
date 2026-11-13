// P001-C1.2.4 - the Docker identity a reinitialize produces must be independent
// even when the process died before removing the inherited one.
//
// C1.2.3 made a pending reinitialize override the binding comparison, so a
// half-finished migration could no longer be mistaken for a settled directory.
// It then returned whatever `installation-id` held, including the case where it
// still held the INHERITED id - the reinitialize had written its marker and
// died before removing it.
//
// That state is not safe:
//
//   * the clone keeps the original's Docker installation id, so every cleanup
//     scoped to that id (`demo_stop_containers`, the CI trap) reaches the
//     original's containers;
//   * the Kernel half is replaced - a new node id, a new credential - which
//     makes the node look isolated while the Docker half is not. That is the
//     same illusion C1.2.2 warned about, in the other direction.
//
// The invariant every test here asserts is the same one, under all the
// intermediate states the migration can be interrupted in:
//
//     a migration that continues or completes never ends with an
//     installation id equal to the one it inherited.
//
// The Docker test at the bottom drives the real adapter, because an id that is
// merely different in a file proves nothing about what the daemon will let the
// clone delete.

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

async fn adapter_or_skip(installation_id: &str) -> Option<opsweave_node::docker::DockerAdapter> {
    let adapter = opsweave_node::docker::DockerAdapter::new("docker".to_string(), docker_host())
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
    assert!(
        !docker(&["inspect", "-f", "{{.Id}}", name]).is_empty(),
        "{name} did not start; this test would be vacuous"
    );
}

fn inspect(name: &str, format: &str) -> String {
    docker(&["inspect", "-f", format, name])
}

/// Arguments for a state directory, without starting anything.
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

fn resolve(dir: &Path, action: opsweave_node::runtime::IdentityAction) -> anyhow::Result<String> {
    Ok(
        opsweave_node::runtime::load_or_create_installation_id_with(&args_for(dir), action)?
            .installation_id,
    )
}

fn marker_path(dir: &Path) -> PathBuf {
    dir.join("reinitialize-in-progress.json")
}

fn write_marker(
    dir: &Path,
    inherited_installation_id: &str,
    inherited_node_id: Option<uuid::Uuid>,
) {
    let mut record = serde_json::json!({
        "inheritedInstallationId": inherited_installation_id,
        "startedAt": "2026-11-13T00:00:00Z",
    });
    if let Some(node_id) = inherited_node_id {
        record["inheritedNodeId"] = serde_json::json!(node_id.to_string());
    }
    std::fs::write(marker_path(dir), record.to_string()).unwrap();
}

fn write_node_identity(dir: &Path, node_id: uuid::Uuid) {
    std::fs::write(
        dir.join("node-identity.json"),
        serde_json::json!({
            "nodeId": node_id,
            "credential": "ow_node_migration_test",
            "dataToken": "ow_data_migration_test",
            "generation": 1,
            "name": "node-a",
        })
        .to_string(),
    )
    .unwrap();
}

fn binding_of(dir: &Path) -> serde_json::Value {
    let bytes = std::fs::read_to_string(dir.join("installation-binding.json"))
        .expect("the migration must leave a binding behind");
    serde_json::from_str(&bytes).unwrap()
}

/// Write a binding that names an arbitrary directory - the shape a copy
/// inherits when it is taken after the migration minted its identity.
fn write_binding_naming(dir: &Path, installation_id: &str, device: u64, inode: u64) {
    std::fs::write(
        dir.join("installation-binding.json"),
        serde_json::json!({
            "installationId": installation_id,
            "stateDirDevice": device,
            "stateDirInode": inode,
            "recordedAt": "2026-11-13T00:00:00Z",
        })
        .to_string(),
    )
    .unwrap();
}

/// A directory that has enrolled once: identity, Kernel identity, binding that
/// names this directory. This is what A looks like before it is cloned.
fn settled(dir: &Path) -> (uuid::Uuid, String) {
    std::fs::create_dir_all(dir).unwrap();
    let node_id = uuid::Uuid::new_v4();
    let installation_id = uuid::Uuid::new_v4().to_string();
    std::fs::write(dir.join("installation-id"), &installation_id).unwrap();
    write_node_identity(dir, node_id);
    let resolved = resolve(dir, opsweave_node::runtime::IdentityAction::None).unwrap();
    assert_eq!(resolved, installation_id, "seeding must bind the id here");
    (node_id, installation_id)
}

/// Scenario A - the reported defect.
///
/// The marker is on disk and the inherited identity was never removed. This is
/// exactly the state `begin_migration()` leaves behind when the process dies
/// between writing the marker and deleting `installation-id`.
#[test]
fn a_marker_beside_the_inherited_identity_never_returns_that_identity() {
    let work = tempfile::tempdir().unwrap();
    let dir = work.path().join("data/node-b");
    let (node_id, inherited) = settled(&dir);

    write_marker(&dir, &inherited, Some(node_id));

    let identity = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&dir),
        opsweave_node::runtime::IdentityAction::None,
    )
    .expect("a pending migration must be continuable without an operator decision");

    assert_ne!(
        identity.installation_id, inherited,
        "the unfinished reinitialize returned the INHERITED installation id. The clone \
         keeps the original's Docker ownership token while its Kernel identity is \
         replaced, so every cleanup scoped to that token reaches the original's \
         containers - and the node looks isolated because the Kernel row is new."
    );
    assert!(
        identity.discard_node_identity,
        "the Kernel identity in this directory is still the original's"
    );
    assert_ne!(
        std::fs::read_to_string(dir.join("installation-id"))
            .unwrap()
            .trim(),
        inherited,
        "the identity file still holds the inherited id"
    );
    assert_eq!(
        binding_of(&dir)["installationId"],
        serde_json::json!(identity.installation_id),
        "the binding does not name the identity the node is running with"
    );
}

/// Scenario B - the next crash point: the inherited identity is gone and the
/// replacement was never minted.
#[test]
fn an_interrupted_removal_still_mints_a_new_identity() {
    let work = tempfile::tempdir().unwrap();
    let dir = work.path().join("data/node-b");
    let (node_id, inherited) = settled(&dir);
    write_marker(&dir, &inherited, Some(node_id));
    std::fs::remove_file(dir.join("installation-id")).unwrap();

    let identity = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&dir),
        opsweave_node::runtime::IdentityAction::None,
    )
    .unwrap();
    assert_ne!(identity.installation_id, inherited);
    assert!(identity.discard_node_identity);
    assert_eq!(
        binding_of(&dir)["installationId"],
        serde_json::json!(identity.installation_id)
    );
}

/// Scenario C - the new id was minted but the binding write never happened.
///
/// `mint_installation_id` writes the identity first and the binding second, so a
/// crash between them leaves exactly this. The identity must not survive into
/// the running node: no binding attests it to this directory, and the migration
/// ends with a different id than the one it inherited, so the cleanup path can
/// never be pointed at the original's containers.
///
/// The alternative - keep the unattested id - would end the migration with a
/// file nothing vouches for. A container labelled with it would then be
/// unreachable by this installation forever, because no start can prove it is
/// ours.
#[test]
fn a_minted_identity_without_a_binding_is_not_adopted() {
    let work = tempfile::tempdir().unwrap();
    let dir = work.path().join("data/node-b");
    let (node_id, inherited) = settled(&dir);
    write_marker(&dir, &inherited, Some(node_id));
    let unattested = uuid::Uuid::new_v4().to_string();
    std::fs::write(dir.join("installation-id"), &unattested).unwrap();
    std::fs::remove_file(dir.join("installation-binding.json")).unwrap();

    let identity = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&dir),
        opsweave_node::runtime::IdentityAction::None,
    )
    .unwrap();
    assert_ne!(
        identity.installation_id, inherited,
        "the migration ended with the INHERITED identity"
    );
    assert_ne!(
        identity.installation_id, unattested,
        "the migration kept an identity no binding attests. Nothing proves this directory \
         minted it, only that a file contains it - so the node would run under a token that \
         may equally belong to another directory, which is the collision C1.2.1 exists to stop."
    );
    assert!(identity.discard_node_identity);
    assert_eq!(
        binding_of(&dir)["installationId"],
        serde_json::json!(identity.installation_id),
        "the migration left an identity nothing attests, so the next start cannot prove \
         what this installation may delete"
    );

    // Idempotent: continuing again yields the same identity, not a third one.
    let again = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&dir),
        opsweave_node::runtime::IdentityAction::None,
    )
    .unwrap();
    assert_eq!(
        again.installation_id, identity.installation_id,
        "the migration mints a new identity on every start instead of settling"
    );
}

/// Scenario C2 - an identity whose binding names ANOTHER directory.
///
/// Distinct from C, and it is the case that proves the binding is checked at
/// all: here `read_binding` returns `Some`, so a "keep whatever is on disk"
/// implementation would look correct. The binding proves this directory did not
/// mint that id, and two directories running under one ownership token is the
/// collision the whole phase exists to prevent - so the copy gets its own.
#[test]
fn an_identity_bound_to_another_directory_is_not_adopted() {
    let work = tempfile::tempdir().unwrap();
    let dir = work.path().join("data/node-b");
    let (node_id, inherited) = settled(&dir);
    write_marker(&dir, &inherited, Some(node_id));
    // A plausible-looking migration result: a new id, bound - but to a
    // different directory. This is a copy made after the migration minted.
    let elsewhere = uuid::Uuid::new_v4().to_string();
    std::fs::write(dir.join("installation-id"), &elsewhere).unwrap();
    write_binding_naming(&dir, &elsewhere, 1, 1);

    let identity = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&dir),
        opsweave_node::runtime::IdentityAction::None,
    )
    .unwrap();
    assert_ne!(
        identity.installation_id, inherited,
        "the migration ended with the INHERITED identity"
    );
    assert_ne!(
        identity.installation_id, elsewhere,
        "the migration adopted an identity whose binding names a different directory: this \
         install now shares an ownership token with whoever minted it"
    );
    assert_eq!(
        binding_of(&dir)["installationId"],
        serde_json::json!(identity.installation_id),
        "the migration did not re-bind the new identity to this directory"
    );
}

/// A clone that has already run `reinitialize`: the marker is on disk, the new
/// identity is minted AND bound to the clone's own directory, and the Kernel
/// identity is still the original's. This is the state a crash leaves between
/// `load_or_create_installation_id` returning and the enrolment completing.
///
/// Built through the real code path rather than by hand: a hand-written identity
/// with no matching binding is a different state (scenario C), and testing one
/// while claiming the other is how a test stops proving what it says.
fn migrated_clone(work: &Path) -> (PathBuf, uuid::Uuid, String, String) {
    let origin = work.join("data/node-a");
    let (node_id, inherited) = settled(&origin);
    let clone = work.join("data/node-b");
    let status = std::process::Command::new("cp")
        .arg("-a")
        .arg(&origin)
        .arg(&clone)
        .status()
        .expect("run cp -a");
    assert!(status.success());
    // `Reinitialize` runs marker -> delete -> mint -> bind in one call, so the
    // states between those steps exist only if a crash creates them. Rebuild
    // them here the way the code does, one step at a time.
    write_marker(&clone, &inherited, Some(node_id));
    std::fs::remove_file(clone.join("installation-id")).unwrap();
    std::fs::remove_file(clone.join("installation-binding.json")).unwrap();
    let fresh = resolve(&clone, opsweave_node::runtime::IdentityAction::None).unwrap();
    assert_ne!(fresh, inherited);
    assert!(marker_path(&clone).exists());
    (clone, node_id, inherited, fresh)
}

/// Scenario D - both identity files are complete, the Kernel identity is not.
///
/// `commit_migration` must refuse: the marker is the only record that this
/// directory must not settle into the Kernel identity it still carries.
#[test]
fn commit_refuses_while_the_kernel_identity_is_still_the_inherited_one() {
    let work = tempfile::tempdir().unwrap();
    let (dir, _, inherited, fresh) = migrated_clone(work.path());
    assert_ne!(fresh, inherited);
    // node-identity.json still holds the inherited node id, and the restart that
    // would normally replace it never happened.

    let error = opsweave_node::runtime::commit_migration(&args_for(&dir))
        .expect_err("commit accepted a directory that still carries the inherited node identity");
    let text = format!("{error:#}");
    assert!(
        text.contains("inherited") && text.contains("Kernel node identity"),
        "the refusal must say which half is wrong, got: {text}"
    );
    assert!(
        marker_path(&dir).exists(),
        "the marker was cleared, so the next start would settle into the inherited identity"
    );
}

/// Scenario D, Docker half - a directory whose marker is on disk and whose
/// inherited installation id was never removed. This is the state
/// `begin_migration()` leaves when the process dies before the first delete, and
/// commit must refuse it even though the Kernel half looks new.
///
/// It also asserts the id does not change on the way out: a refused commit must
/// leave the directory exactly where it was, not half-migrated.
#[test]
fn commit_refuses_while_the_installation_id_is_still_the_inherited_one() {
    let work = tempfile::tempdir().unwrap();
    let dir = work.path().join("data/node-b");
    let (node_id, inherited) = settled(&dir);
    write_marker(&dir, &inherited, Some(node_id));
    // A fresh Kernel identity, as an enrolment that somehow ran first would leave.
    write_node_identity(&dir, uuid::Uuid::new_v4());

    let error = opsweave_node::runtime::commit_migration(&args_for(&dir))
        .expect_err("commit accepted the inherited Docker installation identity");
    assert!(
        format!("{error:#}").contains(&inherited),
        "the refusal should name the id it refuses, got: {error:#}"
    );
    assert!(marker_path(&dir).exists(), "the marker was cleared");
    assert_eq!(
        std::fs::read_to_string(dir.join("installation-id"))
            .unwrap()
            .trim(),
        inherited,
        "a refused commit must not change the identity on the way out"
    );
}

/// Scenario E - enrolment done, commit not reached. A restart finishes the
/// migration and, once both halves hold, commits.
#[test]
fn a_completed_migration_commits_and_then_restarts_normally() {
    let work = tempfile::tempdir().unwrap();
    let (dir, _, inherited, fresh) = migrated_clone(work.path());
    // The enrolment that the crash interrupted.
    write_node_identity(&dir, uuid::Uuid::new_v4());

    opsweave_node::runtime::commit_migration(&args_for(&dir)).expect("both halves hold");
    assert!(!marker_path(&dir).exists(), "the marker was not cleared");

    // Scenario F: after commit this is an ordinary installation.
    let restart = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&dir),
        opsweave_node::runtime::IdentityAction::None,
    )
    .unwrap();
    assert_eq!(restart.installation_id, fresh);
    assert!(
        !restart.discard_node_identity,
        "a committed migration must not keep asking for a new Kernel identity"
    );
    assert_ne!(restart.installation_id, inherited);
}

/// Scenario G - `accept` is "same installation", the opposite of a pending
/// reinitialize, and must not resolve it - nor change the id on the way out.
#[test]
fn accept_cannot_resolve_a_pending_migration() {
    let work = tempfile::tempdir().unwrap();
    let dir = work.path().join("data/node-b");
    let (node_id, inherited) = settled(&dir);
    write_marker(&dir, &inherited, Some(node_id));
    // A copy of the original in a new place: this is what `accept` is for, and
    // it must still be refused while the migration marker is present.
    let copied = dir.join("installation-binding.json");
    let mut binding: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&copied).unwrap()).unwrap();
    binding["stateDirInode"] = serde_json::json!(binding["stateDirInode"].as_u64().unwrap() + 1);
    std::fs::write(&copied, binding.to_string()).unwrap();

    let error = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&dir),
        opsweave_node::runtime::IdentityAction::Accept,
    )
    .expect_err("accept resolved a pending reinitialize");
    assert!(
        format!("{error:#}").contains("INSTALLATION_MIGRATION_IN_PROGRESS"),
        "unexpected error: {error:#}"
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("installation-id"))
            .unwrap()
            .trim(),
        inherited,
        "the refused accept still changed the identity"
    );
}

/// Scenario H - the ordinary paths are untouched: a first install mints, a
/// restart keeps, and neither leaves a migration marker behind.
#[test]
fn first_install_and_restart_are_unchanged() {
    let work = tempfile::tempdir().unwrap();
    let dir = work.path().join("data/node-a");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("installation-id"),
        uuid::Uuid::new_v4().to_string(),
    )
    .unwrap();
    write_node_identity(&dir, uuid::Uuid::new_v4());

    let first = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&dir),
        opsweave_node::runtime::IdentityAction::None,
    )
    .unwrap();
    assert!(!first.discard_node_identity);
    assert!(
        !marker_path(&dir).exists(),
        "an ordinary start wrote a marker"
    );

    let restart = opsweave_node::runtime::load_or_create_installation_id_with(
        &args_for(&dir),
        opsweave_node::runtime::IdentityAction::None,
    )
    .unwrap();
    assert_eq!(restart.installation_id, first.installation_id);
    assert!(!restart.discard_node_identity);
}

/// The Docker consequence, on a real daemon.
///
/// A finished migration is only worth something if the clone's cleanup cannot
/// reach the original's container. Every assertion runs against what the daemon
/// actually holds, and A's container is checked for id, start time, running
/// state and labels afterwards.
#[tokio::test]
async fn a_clone_that_finishes_migration_cannot_reach_the_originals_container() {
    let work = tempfile::tempdir().unwrap();
    let dir_a = work.path().join("data/node-a");
    let (node_id, installation_a) = settled(&dir_a);

    // The clone, interrupted exactly where the defect lives: marker written,
    // inherited identity still present.
    //
    // `dir_b` must NOT exist first: `cp -a src dst` copies *into* dst when dst
    // is a directory, so pre-creating it would produce `dir_b/node-a` and this
    // test would pass without ever exercising the migration.
    let dir_b = work.path().join("data/node-b");
    let status = std::process::Command::new("cp")
        .arg("-a")
        .arg(&dir_a)
        .arg(&dir_b)
        .status()
        .expect("run cp -a");
    assert!(status.success());
    assert_eq!(
        std::fs::read_to_string(dir_b.join("installation-id"))
            .unwrap()
            .trim(),
        installation_a,
        "the clone must carry the original's identity; otherwise this test proves nothing"
    );
    write_marker(&dir_b, &installation_a, Some(node_id));

    let installation_b = resolve(&dir_b, opsweave_node::runtime::IdentityAction::None).unwrap();
    assert_ne!(
        installation_b, installation_a,
        "the clone continued the migration with the original's Docker identity"
    );

    let Some(adapter_b) = adapter_or_skip(&installation_b).await else {
        return;
    };
    let adapter_a = opsweave_node::docker::DockerAdapter::new("docker".to_string(), docker_host())
        .with_installation_id(installation_a.clone());

    // A owns a live container under the name B computes.
    let instance_id = uuid::Uuid::new_v4();
    let name = opsweave_node::docker::container_name(node_id, instance_id);
    run_labelled(
        &name,
        node_id,
        &[("opsweave.installation-id", &installation_a)],
    );
    let before_id = inspect(&name, "{{.Id}}");
    let before_start = inspect(&name, "{{.State.StartedAt}}");
    let before_labels = inspect(&name, "{{json .Config.Labels}}");
    assert_eq!(inspect(&name, "{{.State.Running}}"), "true");

    // Control: the container is reachable by its OWN installation. Without
    // this, a `Foreign` answer below could mean nothing more than a container
    // that was never there.
    assert_eq!(
        adapter_a.ownership_of(&name).await.unwrap(),
        opsweave_node::docker::Ownership::Ours,
        "control failed: A cannot see its own container, so B's answer proves nothing"
    );

    assert_eq!(
        adapter_b.ownership_of(&name).await.unwrap(),
        opsweave_node::docker::Ownership::Foreign,
        "the clone claimed the original's container"
    );
    let swept = adapter_b.list_managed(node_id).await.unwrap();
    assert!(
        !swept.contains(&name),
        "the clone's sweep listed the original's container: {swept:?}"
    );
    assert_eq!(
        adapter_b.stop_and_remove_owned(&name).await.unwrap(),
        opsweave_node::docker::Ownership::Foreign
    );

    // And the container is untouched.
    assert_eq!(inspect(&name, "{{.Id}}"), before_id, "container id changed");
    assert_eq!(
        inspect(&name, "{{.State.StartedAt}}"),
        before_start,
        "container was restarted"
    );
    assert_eq!(inspect(&name, "{{.State.Running}}"), "true");
    assert_eq!(
        inspect(&name, "{{json .Config.Labels}}"),
        before_labels,
        "container labels changed"
    );

    let _ = docker(&["rm", "-f", &name]);
}
