use clap::Parser;
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Parser)]
#[command(
    name = "opsweave-node",
    version,
    about = "OpsWeave Node Runtime (OCI reference adapter)"
)]
pub struct Args {
    #[arg(
        long,
        env = "OPSWEAVE_KERNEL_URL",
        default_value = "http://127.0.0.1:18181"
    )]
    pub kernel_url: String,
    #[arg(long, env = "OPSWEAVE_ENROLLMENT_TOKEN")]
    pub enrollment_token: Option<String>,
    #[arg(long, env = "OPSWEAVE_NODE_NAME", default_value = "node-a")]
    pub node_name: String,
    #[arg(long, env = "OPSWEAVE_NODE_LABELS", default_value = "role=node")]
    pub labels: String,
    #[arg(
        long,
        env = "OPSWEAVE_NODE_DATA_BIND",
        default_value = "127.0.0.1:9101"
    )]
    pub data_bind: String,
    #[arg(
        long,
        env = "OPSWEAVE_NODE_DATA_ENDPOINT",
        default_value = "http://127.0.0.1:9101"
    )]
    pub data_endpoint: String,
    #[arg(
        long,
        env = "OPSWEAVE_DOCKER_HOST",
        default_value = "unix:///var/run/docker.sock"
    )]
    pub docker_host: String,
    #[arg(long, env = "OPSWEAVE_DOCKER_BIN", default_value = "docker")]
    pub docker_bin: String,
    #[arg(long, env = "OPSWEAVE_NODE_STATE_DIR", default_value = "./data/node-a")]
    pub state_dir: PathBuf,
    #[arg(long, env = "OPSWEAVE_NODE_MAX_INSTANCES", default_value_t = 8)]
    pub max_instances: u32,
    #[arg(
        long,
        env = "OPSWEAVE_NODE_LEASE_SECONDS",
        default_value_t = 30,
        help = "Stop workloads when the Kernel has not acknowledged a heartbeat within this lease"
    )]
    pub lease_seconds: u64,
    #[arg(long, env = "OPSWEAVE_NODE_HEARTBEAT_SECONDS", default_value_t = 5)]
    pub heartbeat_seconds: u64,
    #[arg(
        long,
        env = "OPSWEAVE_NODE_STOP_WORKLOADS_ON_EXIT",
        default_value_t = true
    )]
    pub stop_workloads_on_exit: bool,
}

impl Args {
    pub fn label_map(&self) -> BTreeMap<String, String> {
        let mut labels = BTreeMap::new();
        for pair in self.labels.split(',') {
            let pair = pair.trim();
            if pair.is_empty() {
                continue;
            }
            if let Some((key, value)) = pair.split_once('=') {
                labels.insert(key.trim().to_string(), value.trim().to_string());
            }
        }
        labels
    }

    pub fn capabilities(&self) -> Vec<String> {
        vec![
            "oci.docker.v1".into(),
            std::env::consts::OS.to_string(),
            "rootless-docker-reference".into(),
            std::env::consts::ARCH.to_string(),
        ]
    }
}
