// P001-C1.2 - container ownership against a REAL Docker daemon.
//
// The unit tests in `docker.rs` drive a fake `docker` binary. They prove the
// ownership decision, but they cannot prove what the daemon does when two
// installations collide on one name. This integration test does: it runs the
// compiled adapter against the host's daemon with two different installation
// ids, and asserts on the container that is actually left on the daemon.
//
// Gated like the kernel's database tests: no daemon and nobody asking for one
// means skip; `OPSWEAVE_REQUIRE_TEST_DOCKER=1` turns a missing daemon into a
// failure, so a CI job can never report a green test that asserted nothing.
//
// Covered end to end here:
//   1. two installations have different ownership ids
//   2. B cannot remove A's container, even though it computes the same name
//   3. the collision is a diagnosable error (CONTAINER_OWNERSHIP_CONFLICT)
//   4. A's container keeps its id, started-at, running state and labels
//   5. an installation still removes a container it does own
//   6. a container with no installation label is never assumed to be ours
use opsweave_contracts::{DesiredAction, DesiredBackend, DesiredWorkload, ResourceRequirements};
use opsweave_node::docker::{container_name, DockerAdapter, Ownership};
use std::collections::BTreeMap;

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
            other => panic!(
                "{REQUIRE_DOCKER_ENV} is set to {other:?}: use 1 to require the \
                 daemon-backed tests"
            ),
        },
    }
}

/// `None` means "no daemon and nobody asked for one". The caller returns early.
async fn adapter_or_skip(installation_id: &str) -> Option<DockerAdapter> {
    let adapter = DockerAdapter::new("docker".to_string(), docker_host())
        .with_installation_id(installation_id);
    match adapter.version().await {
        Ok(_) => Some(adapter),
        Err(error) => {
            if docker_required() {
                panic!("{REQUIRE_DOCKER_ENV} is set but Docker is unavailable: {error:#}");
            }
            eprintln!("skip: Docker is unavailable ({error:#}) and {REQUIRE_DOCKER_ENV} is not 1");
            None
        }
    }
}

fn docker_host() -> String {
    std::env::var("OPSWEAVE_DOCKER_HOST").unwrap_or_else(|_| "unix:///var/run/docker.sock".into())
}

/// Run `docker` directly, for assertions the adapter does not expose.
fn docker(args: &[&str]) -> String {
    let output = std::process::Command::new("docker")
        .args(args)
        .env("DOCKER_HOST", docker_host())
        .output()
        .expect("run docker");
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// A container on the daemon that reports `label=value`, started as `alpine:3`.
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
    args.push("alpine:3".into());
    args.push("sh".into());
    args.push("-c".into());
    args.push("while true; do sleep 5; done".into());
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

fn workload(instance_id: uuid::Uuid) -> DesiredWorkload {
    DesiredWorkload {
        instance_id,
        deployment_id: uuid::Uuid::new_v4(),
        plugin_id: "dev.opsweave.ownership-test".into(),
        version: "0.0.1".into(),
        generation: 1,
        action: DesiredAction::Start,
        backend: DesiredBackend {
            image_ref: "alpine:3".into(),
            container_port: 80,
            capability_digest: "sha256:test".into(),
            readiness_path: "/ready".into(),
            liveness_path: "/live".into(),
            startup_path: None,
            api_prefix: "/api".into(),
        },
        resources: ResourceRequirements {
            cpu_millis: 200,
            memory_mib: 64,
        },
        labels: BTreeMap::new(),
    }
}

#[tokio::test]
async fn a_second_installation_cannot_take_over_a_running_container() {
    let installation_a = uuid::Uuid::new_v4().to_string();
    let installation_b = uuid::Uuid::new_v4().to_string();
    let Some(adapter_b) = adapter_or_skip(&installation_b).await else {
        return;
    };
    // A's adapter is only used for its identity; A's container is started
    // directly so this test does not depend on A's create path succeeding.
    let node_id = uuid::Uuid::new_v4();
    let instance_id = uuid::Uuid::new_v4();
    let name = container_name(node_id, instance_id);

    // 1. The two installations really are distinguishable.
    assert_ne!(installation_a, installation_b);

    // 2. A owns a live container under the name B will compute.
    run_labelled(
        &name,
        node_id,
        &[("opsweave.installation-id", &installation_a)],
    );
    let before_id = inspect(&name, "{{.Id}}");
    let before_start = inspect(&name, "{{.State.StartedAt}}");
    let before_labels = inspect(&name, "{{json .Config.Labels}}");
    let before_running = inspect(&name, "{{.State.Running}}");
    assert_eq!(before_running, "true");

    // 3. B sees it as foreign, not as its own.
    assert_eq!(
        adapter_b.ownership_of(&name).await.unwrap(),
        Ownership::Foreign,
        "B claimed ownership of A's container"
    );

    // 4. B's create path refuses rather than removing it. This is the
    //    regression: `create_and_start` used to `docker rm -f` the name first.
    let error = adapter_b
        .create_and_start(
            &workload(instance_id),
            "alpine:3",
            80,
            node_id,
            &BTreeMap::new(),
            None,
            &[],
        )
        .await
        .expect_err("B was allowed to create over A's container");
    let text = format!("{error:#}");
    assert!(
        text.contains("CONTAINER_OWNERSHIP_CONFLICT"),
        "the collision was not diagnosable: {text}"
    );

    // 5. A's container is exactly as it was: id, start time, state, labels.
    assert_eq!(inspect(&name, "{{.Id}}"), before_id, "container id changed");
    assert_eq!(
        inspect(&name, "{{.State.StartedAt}}"),
        before_start,
        "container was restarted"
    );
    assert_eq!(
        inspect(&name, "{{.State.Running}}"),
        "true",
        "container was stopped"
    );
    assert_eq!(
        inspect(&name, "{{json .Config.Labels}}"),
        before_labels,
        "container labels changed"
    );

    // 6. B's sweep does not enumerate A's container.
    let swept = adapter_b.list_managed(node_id).await.unwrap();
    assert!(
        !swept.contains(&name),
        "B's sweep listed A's container: {swept:?}"
    );

    // 7. But B does remove a container it actually owns.
    let own_instance = uuid::Uuid::new_v4();
    let own_name = container_name(node_id, own_instance);
    run_labelled(
        &own_name,
        node_id,
        &[("opsweave.installation-id", &installation_b)],
    );
    assert_eq!(
        adapter_b.stop_and_remove_owned(&own_name).await.unwrap(),
        Ownership::Ours
    );
    assert!(
        inspect(&own_name, "{{.Id}}").is_empty(),
        "B could not remove a container it owns"
    );
    assert_eq!(
        inspect(&name, "{{.Id}}"),
        before_id,
        "B's cleanup reached A's container"
    );

    let _ = docker(&["rm", "-f", &name]);
}

#[tokio::test]
async fn a_container_with_no_installation_label_is_never_swept() {
    let installation = uuid::Uuid::new_v4().to_string();
    let Some(adapter) = adapter_or_skip(&installation).await else {
        return;
    };
    let node_id = uuid::Uuid::new_v4();
    // A container from a version that predates the installation label: it has
    // the managed and node-id labels, and nothing else.
    let name = container_name(node_id, uuid::Uuid::new_v4());
    run_labelled(&name, node_id, &[]);
    let before_id = inspect(&name, "{{.Id}}");

    assert_eq!(
        adapter.ownership_of(&name).await.unwrap(),
        Ownership::Foreign,
        "an unlabelled container was claimed as ours"
    );
    let swept = adapter.list_managed(node_id).await.unwrap();
    assert!(
        !swept.contains(&name),
        "an unlabelled container was swept: {swept:?}"
    );
    assert_eq!(
        adapter.stop_and_remove_owned(&name).await.unwrap(),
        Ownership::Foreign
    );
    assert_eq!(
        inspect(&name, "{{.Id}}"),
        before_id,
        "a pre-upgrade container was removed"
    );

    let _ = docker(&["rm", "-f", &name]);
}

/// Adoption is the fourth path that can take over another installation's
/// container. `run_once` adopts a running container whose name and image match,
/// and it used to do so without asking who owned it - which is enough for a
/// second installation sharing a node id, because it runs the same plugin
/// version and therefore the same image.
#[tokio::test]
async fn a_running_container_with_the_same_name_and_image_is_not_adopted() {
    let installation_a = uuid::Uuid::new_v4().to_string();
    let installation_b = uuid::Uuid::new_v4().to_string();
    let Some(adapter_b) = adapter_or_skip(&installation_b).await else {
        return;
    };
    let node_id = uuid::Uuid::new_v4();
    let instance_id = uuid::Uuid::new_v4();
    let name = container_name(node_id, instance_id);

    // A runs the same image, under the same name, that B would compute.
    run_labelled(
        &name,
        node_id,
        &[("opsweave.installation-id", &installation_a)],
    );
    let before_id = inspect(&name, "{{.Id}}");

    // The adoption predicate in `run_once` is "running and image matches";
    // ownership is what it must also require. `ownership_of` is that check.
    assert_eq!(inspect(&name, "{{.Config.Image}}"), "alpine:3");
    assert_eq!(inspect(&name, "{{.State.Running}}"), "true");
    assert_eq!(
        adapter_b.ownership_of(&name).await.unwrap(),
        Ownership::Foreign,
        "B would adopt A's container: the name and image match, but it is not B's"
    );

    // And B's removal path leaves it alone.
    assert_eq!(
        adapter_b.stop_and_remove_owned(&name).await.unwrap(),
        Ownership::Foreign
    );
    assert_eq!(inspect(&name, "{{.Id}}"), before_id);

    let _ = docker(&["rm", "-f", &name]);
}
