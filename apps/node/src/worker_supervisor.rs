//! Supervises the trusted Node-side pipeline worker process.
//!
//! This is deliberately a Node Runtime child, not a plugin container. It inherits
//! the enrolled Node identity file path, never the credential value in a Pipeline,
//! and is bounded to one running worker unless explicitly configured otherwise.

use crate::runtime::{RuntimeState, Shared};
use std::sync::{atomic::Ordering, Arc};
use std::time::{Duration, Instant};
use uuid::Uuid;

async fn terminate_child(child: &mut tokio::process::Child) -> bool {
    let Some(pid) = child.id() else {
        return false;
    };
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    #[cfg(not(unix))]
    let _ = child.start_kill();
    match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
        Ok(Ok(status)) => {
            tracing::info!(%status, %pid, "worker exited on SIGTERM");
            true
        }
        _ => {
            tracing::warn!(%pid, "worker did not exit within 5s; SIGKILL and reap");
            let _ = child.start_kill();
            let _ = child.wait().await;
            false
        }
    }
}

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
        let mut shutdown = shared.shutdown.subscribe();
        loop {
            if *shutdown.borrow() {
                break;
            }
            if !enable_marker.exists() || shared.quarantined.load(Ordering::SeqCst) {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                    changed = shutdown.changed() => { if changed.is_err() || *shutdown.borrow() { break; } }
                }
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
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                    changed = shutdown.changed() => { if changed.is_err() || *shutdown.borrow() { break; } }
                }
                continue;
            };
            let generation = shared.identity.read().await.generation;
            let worker_kernel_url = std::env::var("OPSWEAVE_WORKER_KERNEL_URL")
                .unwrap_or_else(|_| shared.args.kernel_url.clone());
            let boot_id = Uuid::new_v4();
            tracing::info!(%instance_id, %boot_id, "starting node-managed pipeline worker");
            let mut command = tokio::process::Command::new(&bin);
            command
                .kill_on_drop(true)
                .env("OPSWEAVE_WORKER_KERNEL_URL", &worker_kernel_url)
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
                    tokio::select! {
                        _ = backoff(failures) => {}
                        changed = shutdown.changed() => { if changed.is_err() || *shutdown.borrow() { break; } }
                    }
                    continue;
                }
            };
            loop {
                if *shutdown.borrow() {
                    tracing::info!(%instance_id, "worker supervisor shutdown");
                    let _ = terminate_child(&mut child).await;
                    return;
                }
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
                    Ok(None) => {
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_millis(500)) => {}
                            changed = shutdown.changed() => { if changed.is_err() || *shutdown.borrow() { break; } }
                        }
                    }
                    Err(error) => {
                        tracing::error!(%error, "worker status check failed");
                        let _ = child.start_kill();
                        let _ = child.wait().await;
                        break;
                    }
                }
            }
            if *shutdown.borrow() {
                let _ = terminate_child(&mut child).await;
                break;
            }
            failures = if started.elapsed() > Duration::from_secs(60) {
                0
            } else {
                failures.saturating_add(1)
            };
            tokio::select! {
                _ = backoff(failures) => {}
                changed = shutdown.changed() => { if changed.is_err() || *shutdown.borrow() { break; } }
            }
        }
    })
}

/// The delay before restarting a worker that has failed `failures` times.
///
/// Extracted from `backoff` so the curve can be asserted without sleeping. It had
/// no test at all, and it contains three arithmetic steps that can each go wrong
/// silently: the shift is capped at 4 (so `1 << failures` cannot overflow), the
/// multiply is saturating, and the result is capped at 30 s.
///
/// The failure this guards against is not a crash - it is a supervisor that stops
/// backing off. A worker that fails instantly and is restarted instantly is a busy
/// loop that fills the log and burns CPU on the node; the cap is what prevents it,
/// and nothing was checking that the cap exists.
fn backoff_seconds(failures: u32) -> u64 {
    2u64.saturating_mul(1u64 << failures.min(4)).min(30)
}

async fn backoff(failures: u32) {
    tokio::time::sleep(Duration::from_secs(backoff_seconds(failures))).await;
}

#[cfg(test)]
mod backoff_tests {
    use super::backoff_seconds;

    #[test]
    fn the_delay_doubles_until_it_is_capped() {
        // 2 * 2^n for n = 0..=4, then flat.
        assert_eq!(backoff_seconds(0), 2);
        assert_eq!(backoff_seconds(1), 4);
        assert_eq!(backoff_seconds(2), 8);
        assert_eq!(backoff_seconds(3), 16);
        assert_eq!(
            backoff_seconds(4),
            30,
            "the cap applies at n = 4 (32 would be uncapped)"
        );
    }

    #[test]
    fn the_delay_never_exceeds_the_cap() {
        // The cap is what stops an instantly-failing worker from becoming a busy
        // loop. Assert it for a range that includes the shift's own clamp.
        for failures in 0..64u32 {
            let seconds = backoff_seconds(failures);
            assert!(
                seconds <= 30,
                "failures={failures} produced {seconds}s, above the 30s cap"
            );
            assert!(
                seconds >= 2,
                "failures={failures} produced {seconds}s, below the floor"
            );
        }
    }

    #[test]
    fn a_large_failure_count_does_not_overflow() {
        // `1u64 << failures` would overflow at 64; `.min(4)` is what prevents it.
        // This asserts the clamp is present rather than trusting it by inspection.
        assert_eq!(backoff_seconds(u32::MAX), 30);
    }
}
