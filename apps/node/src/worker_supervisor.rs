//! Supervises the trusted Node-side pipeline worker process.
//!
//! This is deliberately a Node Runtime child, not a plugin container. It inherits
//! the enrolled Node identity file path, never the credential value in a Pipeline,
//! and is bounded to one running worker unless explicitly configured otherwise.

use crate::runtime::{RuntimeState, Shared};
use std::sync::{atomic::Ordering, Arc};
use std::time::{Duration, Instant};
use uuid::Uuid;

pub fn spawn(shared: Arc<Shared>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if std::env::var("OPSWEAVE_NODE_WORKER_ENABLED").as_deref() != Ok("1") {
            tracing::info!("node-managed pipeline worker disabled");
            return;
        }
        let bin = std::env::var("OPSWEAVE_PIPELINE_WORKER_BIN")
            .unwrap_or_else(|_| "target/debug/opsweave-pipeline-worker".to_string());
        let identity_path = shared.args.state_dir.join("node-identity.json");
        let enable_marker = shared.args.state_dir.join("worker-enabled");
        let mut failures = 0u32;
        loop {
            if !enable_marker.exists() || shared.quarantined.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
            let ready_instance = {
                let runtimes = shared.runtimes.read().await;
                runtimes
                    .values()
                    .find(|runtime| runtime.status_copy().state == RuntimeState::Ready)
                    .map(|runtime| runtime.workload.instance_id)
            };
            let Some(instance_id) = ready_instance else {
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            };
            let generation = shared.identity.read().await.generation;
            let boot_id = Uuid::new_v4();
            tracing::info!(%instance_id, %boot_id, "starting node-managed pipeline worker");
            let mut command = tokio::process::Command::new(&bin);
            command
                .kill_on_drop(true)
                .env("OPSWEAVE_WORKER_KERNEL_URL", &shared.args.kernel_url)
                .env("OPSWEAVE_WORKER_NODE_IDENTITY", &identity_path)
                .env("OPSWEAVE_WORKER_INSTANCE_ID", instance_id.to_string())
                .env("OPSWEAVE_WORKER_NODE_GENERATION", generation.to_string())
                .env("OPSWEAVE_WORKER_BOOT_ID", boot_id.to_string());
            if let Ok(allowlist) = std::env::var("OPSWEAVE_WORKER_SOURCE_ALLOWLIST") {
                command.env("OPSWEAVE_WORKER_SOURCE_ALLOWLIST", allowlist);
            }
            if let Ok(delay) = std::env::var("OPSWEAVE_WORKER_BATCH_DELAY_MS") {
                command.env("OPSWEAVE_WORKER_BATCH_DELAY_MS", delay);
            }
            let started = Instant::now();
            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    failures = failures.saturating_add(1);
                    tracing::error!(%error, bin, "failed to start node-managed pipeline worker");
                    backoff(failures).await;
                    continue;
                }
            };
            loop {
                let instance_ready = {
                    let runtimes = shared.runtimes.read().await;
                    runtimes
                        .get(&instance_id)
                        .is_some_and(|runtime| runtime.status_copy().state == RuntimeState::Ready)
                };
                if !enable_marker.exists()
                    || !instance_ready
                    || shared.quarantined.load(Ordering::SeqCst)
                {
                    tracing::warn!(%instance_id, "stopping worker: node or instance is no longer eligible");
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    break;
                }
                match child.try_wait() {
                    Ok(Some(status)) => {
                        tracing::warn!(%status, "node-managed pipeline worker exited");
                        break;
                    }
                    Ok(None) => tokio::time::sleep(Duration::from_millis(500)).await,
                    Err(error) => {
                        tracing::error!(%error, "worker status check failed");
                        let _ = child.start_kill();
                        let _ = child.wait().await;
                        break;
                    }
                }
            }
            failures = if started.elapsed() > Duration::from_secs(60) {
                0
            } else {
                failures.saturating_add(1)
            };
            backoff(failures).await;
        }
    })
}

async fn backoff(failures: u32) {
    let seconds = 2u64.saturating_mul(1u64 << failures.min(4));
    tokio::time::sleep(Duration::from_secs(seconds.min(30))).await;
}
