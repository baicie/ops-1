mod applications;
mod assets;
mod audit;
mod auth;
mod capabilities;
mod config;
mod db;
mod deployments;
mod diagnostics;
mod error;
mod gateway;
mod jobs;
mod logs;
mod nodes;
mod packages;
mod pipeline;
mod plugins;
mod publishers;
mod receipts;
mod routes;
mod scope;
mod signing;
mod state;
mod static_site;
mod storage;
mod users;
mod workspaces;

// P001-A: the Ops business application. Compiled only when `business-ops` is on
// (the default). With it off these modules do not exist in the binary, so their
// routes cannot be mounted and their workers cannot start - see the feature
// comment in Cargo.toml for why the job engine stays core.
#[cfg(feature = "business-ops")]
mod automation;
#[cfg(feature = "business-ops")]
mod automation_flow;
#[cfg(feature = "business-ops")]
mod automation_worker;
#[cfg(feature = "business-ops")]
mod incident_claims;
#[cfg(feature = "business-ops")]
mod incidents;
#[cfg(feature = "business-ops")]
mod investigations;
#[cfg(feature = "business-ops")]
mod ops_observability;
#[cfg(feature = "business-ops")]
mod telemetry_events;
#[cfg(feature = "business-ops")]
mod telemetry_sources;

use anyhow::Context;
use std::sync::OnceLock;
use std::time::Instant;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

static START: OnceLock<Instant> = OnceLock::new();

pub fn uptime_seconds() -> u64 {
    START
        .get()
        .map(|start| start.elapsed().as_secs())
        .unwrap_or(0)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    START.get_or_init(Instant::now);
    init_tracing();
    let config = config::Config::from_env();
    std::fs::create_dir_all(config.data_dir.join("packages"))
        .context("create package store directory")?;
    std::fs::create_dir_all(config.data_dir.join("backups")).context("create backup directory")?;

    let pool = db::connect(&config.database_url).await?;
    db::migrate(&pool).await?;
    let cursor_secret = db::load_or_create_cursor_secret(&pool).await?;
    let state = state::AppState::new(config.clone(), pool, cursor_secret)?;
    db::init(&state).await?;
    // P001-A: these two exist only to serve the Ops business application - the
    // telemetry source registry is its input, and the automation worker is its
    // Evidence producer. On a platform-only build neither module is compiled, so
    // neither runs. That is the difference between "the worker is idle because
    // nothing is installed" and "there is no worker", and only the second one is
    // a platform that does not depend on a business domain.
    #[cfg(feature = "business-ops")]
    {
        telemetry_sources::sync(
            &state.db,
            &state.config.automation_sources,
            &state.config.plugin_credential_bindings,
            state.config.allow_insecure_source_endpoints,
        )
        .await
        .context("reconcile the telemetry source registry")?;
        automation_worker::spawn(state.clone());
    }
    // Platform concerns, present in both builds: node/deployment reconciliation
    // and node resource retention are about the platform's own substrate.
    deployments::spawn_reconciler(state.clone());
    nodes::spawn_resource_retention(state.clone());

    let listener = tokio::net::TcpListener::bind(&config.bind)
        .await
        .with_context(|| format!("bind {}", config.bind))?;
    tracing::info!(
        address = %config.bind,
        data_dir = %config.data_dir.display(),
        web_dist = %config.web_dist.display(),
        "OpsWeave Kernel listening"
    );
    axum::serve(
        listener,
        routes::build(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .context("serve kernel")?;
    Ok(())
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,opsweave_kernel=debug,tower_http=info"));
    let registry = tracing_subscriber::registry().with(filter);
    if std::env::var("OPSWEAVE_LOG_FORMAT").as_deref() == Ok("json") {
        registry
            .with(tracing_subscriber::fmt::layer().json())
            .init();
    } else {
        registry.with(tracing_subscriber::fmt::layer()).init();
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install Ctrl+C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}
