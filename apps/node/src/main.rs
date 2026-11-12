// The library target (`src/lib.rs`) carries the same modules so integration
// tests can drive the real adapter. Declaring them again here would compile two
// copies and, worse, let `main` and the tests drift apart.
mod api;
mod worker_supervisor;

use anyhow::Context;
use clap::Parser;
use opsweave_node::config::Args;
use opsweave_node::docker::DockerAdapter;
use opsweave_node::runtime::{self, Shared};
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::RwLock;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    init_tracing();
    let args = Args::parse();
    std::fs::create_dir_all(&args.state_dir).context("create node state directory")?;
    let http = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(3))
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let docker = DockerAdapter::new(args.docker_bin.clone(), args.docker_host.clone());
    let docker_version = docker
        .version()
        .await
        .context("Docker Engine is required by the OCI reference adapter")?;
    // Before any container is created: every container this installation makes
    // must carry a label that distinguishes it from an installation which
    // inherited the same node id. See DockerAdapter::INSTALLATION_LABEL.
    // Fails closed on `INSTALLATION_IDENTITY_CONFLICT`: a state directory that
    // is a copy of the one its identity was minted in cannot be told apart from
    // the original, and two installations sharing an ownership token delete each
    // other's containers. The operator resolves it once, explicitly. ADR-023.
    let installation = runtime::load_or_create_installation_id(&args)
        .context("the Node cannot establish which containers it owns, so it will not start")?;
    let docker = docker.with_installation_id(installation.installation_id.clone());
    // `reinitialize` means this directory is a clone, so the Kernel identity in
    // it - node id, control credential, data token, generation - belongs to the
    // installation it was copied from. Keeping it makes two processes heartbeat
    // one node row: they overwrite each other's generation, last_seen_at and
    // data_endpoint, and both receive the same desired workloads. ADR-023 §2.2a.
    //
    // The inherited file is not deleted up front. It is set aside, the new
    // enrolment is obtained, and only then is it replaced - so a failed
    // enrolment leaves the directory exactly as it was and can be retried. It
    // never falls back to the shared credential.
    let previous_identity = if installation.discard_node_identity {
        runtime::set_aside_node_identity(&args).context(
            "reinitialize could not set aside the inherited Kernel identity; nothing was              changed and the directory is still the one it was",
        )?
    } else {
        None
    };
    let identity = match runtime::enroll(&args, &http).await {
        Ok(identity) => identity,
        Err(error) => {
            if let Some(previous) = previous_identity {
                runtime::restore_node_identity(&args, &previous);
            }
            return Err(error).context(
                "reinitialize needs a NEW enrolment token: the one this clone inherited was                  spent by the original enrolment and the Kernel refuses it twice. The previous                  identity has been restored, so this directory is unchanged and can be retried                  with OPSWEAVE_ENROLLMENT_TOKEN set to a fresh token",
            );
        }
    };
    let node_id = identity.node_id;
    let empty_desired = opsweave_contracts::DesiredNodeState {
        node_id,
        node_generation: identity.generation,
        heartbeat_interval_seconds: args.heartbeat_seconds as u32,
        max_instances: args.max_instances,
        desired: vec![],
    };
    let (shutdown_tx, _shutdown_rx) = tokio::sync::watch::channel(false);
    let shared = Arc::new(Shared {
        args: args.clone(),
        http,
        docker,
        docker_version: docker_version.clone(),
        identity: RwLock::new(identity),
        desired: RwLock::new(empty_desired),
        runtimes: Arc::new(RwLock::new(HashMap::new())),
        tasks: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        lifecycle: Arc::new(tokio::sync::Mutex::new(())),
        metrics: Arc::new(StdMutex::new(runtime::MetricsState::default())),
        quarantined: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        quarantine_error: Arc::new(StdMutex::new(None)),
        lease_deadline: Arc::new(StdMutex::new(None)),
        shutdown: Arc::new(shutdown_tx),
        extra_container_labels: args
            .container_labels
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
    });

    let listener = tokio::net::TcpListener::bind(&args.data_bind)
        .await
        .with_context(|| format!("bind node data endpoint {}", args.data_bind))?;
    tracing::info!(
        node_id = %node_id,
        name = %args.node_name,
        generation = shared.identity.read().await.generation,
        data_bind = %args.data_bind,
        docker = %docker_version,
        "OpsWeave Node Runtime started"
    );

    let api = api::router(shared.clone());
    let api_task = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, api).await {
            tracing::error!(error = %error, "node data API stopped");
        }
    });
    let heartbeat = tokio::spawn(runtime::heartbeat_loop(shared.clone()));
    let lease_watchdog = tokio::spawn(runtime::lease_watchdog(shared.clone()));
    let worker_supervisor = worker_supervisor::spawn(shared.clone());

    wait_for_shutdown_signal().await?;
    tracing::info!("shutdown signal received; stopping supervision");
    let _ = shared.shutdown.send(true);
    heartbeat.abort();
    lease_watchdog.abort();
    api_task.abort();
    // The supervisor observes the watch channel, sends SIGTERM to its child,
    // waits with a hard bound, then SIGKILLs and reaps. Do not abort it before
    // it has completed that sequence.
    match tokio::time::timeout(std::time::Duration::from_secs(20), worker_supervisor).await {
        Ok(Ok(())) => tracing::info!("worker supervisor shut down"),
        Ok(Err(error)) => tracing::error!(%error, "worker supervisor join failed"),
        Err(_) => tracing::error!("worker supervisor shutdown exceeded 20s bound"),
    }
    if args.stop_workloads_on_exit {
        let tasks = shared.tasks.lock().await;
        for task in tasks.values() {
            let _ = task.cancel.send(true);
        }
        drop(tasks);
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    } else {
        tracing::info!("leaving managed containers running for re-adoption on restart");
    }
    Ok(())
}

#[cfg(unix)]
async fn wait_for_shutdown_signal() -> anyhow::Result<()> {
    use tokio::signal::unix::{signal, SignalKind};
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    tokio::select! {
        _ = terminate.recv() => {}
        _ = interrupt.recv() => {}
        result = tokio::signal::ctrl_c() => { result?; }
    }
    Ok(())
}

#[cfg(not(unix))]
async fn wait_for_shutdown_signal() -> anyhow::Result<()> {
    tokio::signal::ctrl_c().await?;
    Ok(())
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,opsweave_node=debug"));
    let registry = tracing_subscriber::registry().with(filter);
    if std::env::var("OPSWEAVE_LOG_FORMAT").as_deref() == Ok("json") {
        registry
            .with(tracing_subscriber::fmt::layer().json())
            .init();
    } else {
        registry.with(tracing_subscriber::fmt::layer()).init();
    }
}
