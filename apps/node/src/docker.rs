use anyhow::{anyhow, Context};
use opsweave_contracts::DesiredWorkload;
use std::process::Stdio;
use tokio::process::{Child, Command};

#[derive(Debug, Clone)]
pub struct DockerAdapter {
    pub binary: String,
    pub host: String,
}

#[derive(Debug, Clone)]
pub struct ContainerInfo {
    pub id: String,
    pub running: bool,
    pub image: String,
    pub host_port: Option<u16>,
}

impl DockerAdapter {
    pub fn new(binary: String, host: String) -> Self {
        Self { binary, host }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.binary);
        command.env("DOCKER_HOST", &self.host);
        command
    }

    pub async fn version(&self) -> anyhow::Result<String> {
        let output = self
            .command()
            .arg("version")
            .arg("--format")
            .arg("{{.Server.Version}}")
            .output()
            .await
            .context("run docker version")?;
        if !output.status.success() {
            return Err(anyhow!(
                "docker engine is unavailable: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    async fn run(&self, args: &[&str]) -> anyhow::Result<String> {
        let output = self
            .command()
            .args(args)
            .output()
            .await
            .with_context(|| format!("run docker {}", args.join(" ")))?;
        if !output.status.success() {
            return Err(anyhow!(
                "docker {} failed: {}",
                args.first().unwrap_or(&""),
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    pub async fn pull(&self, image_ref: &str) -> anyhow::Result<()> {
        self.run(&["pull", image_ref]).await?;
        Ok(())
    }

    /// Verify that the local image's content digest matches the digest pinned in
    /// the signed manifest. Tag fallback is never accepted.
    pub async fn verify_digest(&self, image_ref: &str) -> anyhow::Result<()> {
        let requested = image_ref
            .rsplit_once("@sha256:")
            .map(|(_, digest)| format!("sha256:{digest}"))
            .ok_or_else(|| anyhow!("imageRef must be pinned by sha256 digest"))?;
        let raw = self
            .run(&[
                "image",
                "inspect",
                image_ref,
                "--format",
                "{{json .RepoDigests}}",
            ])
            .await?;
        let digests: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
        if !digests.iter().any(|value| value.ends_with(&requested)) {
            return Err(anyhow!(
                "image digest mismatch: requested {requested}, local RepoDigests {digests:?}"
            ));
        }
        Ok(())
    }

    pub async fn inspect(&self, name: &str) -> anyhow::Result<Option<ContainerInfo>> {
        let output = self
            .command()
            .args([
                "inspect",
                name,
                "--format",
                "{{.Id}}|{{.State.Running}}|{{.Config.Image}}",
            ])
            .output()
            .await?;
        if !output.status.success() {
            return Ok(None);
        }
        let raw = String::from_utf8_lossy(&output.stdout);
        let mut parts = raw.trim().split('|');
        let id = parts.next().unwrap_or_default().to_string();
        let running = parts.next().unwrap_or("false") == "true";
        let image = parts.next().unwrap_or_default().to_string();
        let host_port = self.port_of(name).await.ok().flatten();
        Ok(Some(ContainerInfo {
            id,
            running,
            image,
            host_port,
        }))
    }

    async fn port_of(&self, name: &str) -> anyhow::Result<Option<u16>> {
        let raw = self
            .run(&[
                "inspect",
                name,
                "--format",
                "{{json .NetworkSettings.Ports}}",
            ])
            .await?;
        let value: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(value) => value,
            Err(_) => return Ok(None),
        };
        let Some(map) = value.as_object() else {
            return Ok(None);
        };
        for (_, bindings) in map {
            if let Some(bindings) = bindings.as_array() {
                for binding in bindings {
                    if let Some(port) = binding
                        .get("HostPort")
                        .and_then(|value| value.as_str())
                        .and_then(|value| value.parse::<u16>().ok())
                    {
                        return Ok(Some(port));
                    }
                }
            }
        }
        Ok(None)
    }

    pub async fn remove_if_exists(&self, name: &str) {
        let _ = self.command().args(["rm", "-f", name]).output().await;
    }

    pub async fn create_and_start(
        &self,
        workload: &DesiredWorkload,
        image_ref: &str,
        container_port: u16,
        node_id: uuid::Uuid,
    ) -> anyhow::Result<String> {
        let name = container_name(node_id, workload.instance_id);
        self.remove_if_exists(&name).await;
        let cpu = format!("{:.3}", workload.resources.cpu_millis as f64 / 1000.0);
        let memory = format!("{}m", workload.resources.memory_mib);
        let publish = format!("127.0.0.1::{container_port}");
        let tmpfs = "/tmp:rw,noexec,nosuid,size=64m".to_string();
        let memory_swap = memory.clone();
        let instance_label = format!("opsweave.instance-id={}", workload.instance_id);
        let deployment_label = format!("opsweave.deployment-id={}", workload.deployment_id);
        let plugin_label = format!("opsweave.plugin-id={}", workload.plugin_id);
        let version_label = format!("opsweave.version={}", workload.version);
        let node_label = format!("opsweave.node-id={node_id}");
        let env_instance = format!("OPSWEAVE_INSTANCE_ID={}", workload.instance_id);
        let env_plugin = format!("OPSWEAVE_PLUGIN_ID={}", workload.plugin_id);
        let env_version = format!("OPSWEAVE_VERSION={}", workload.version);
        let args = vec![
            "create",
            "--name",
            &name,
            "--label",
            "opsweave.managed=true",
            "--label",
            &instance_label,
            "--label",
            &deployment_label,
            "--label",
            &plugin_label,
            "--label",
            &version_label,
            "--label",
            &node_label,
            "--memory",
            &memory,
            "--memory-swap",
            &memory_swap,
            "--cpus",
            &cpu,
            "--pids-limit",
            "256",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--read-only",
            "--tmpfs",
            &tmpfs,
            "--restart",
            "unless-stopped",
            "--publish",
            &publish,
            "--env",
            &env_instance,
            "--env",
            &env_plugin,
            "--env",
            &env_version,
            image_ref,
        ];
        let id = self.run(&args).await?;
        self.run(&["start", &name]).await?;
        if id.is_empty() {
            return Err(anyhow!("docker create returned no container id"));
        }
        Ok(id)
    }

    pub async fn list_managed(&self, node_id: uuid::Uuid) -> anyhow::Result<Vec<String>> {
        let filter = format!("label=opsweave.node-id={node_id}");
        let raw = self
            .run(&[
                "ps",
                "-a",
                "--filter",
                "label=opsweave.managed=true",
                "--filter",
                &filter,
                "--format",
                "{{.Names}}",
            ])
            .await?;
        Ok(raw
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect())
    }

    pub async fn stop_and_remove(&self, name: &str) -> anyhow::Result<()> {
        let _ = self
            .command()
            .args(["stop", "--time", "10", name])
            .output()
            .await;
        let _ = self.command().args(["rm", "-f", name]).output().await;
        Ok(())
    }

    pub fn spawn_logs(&self, name: &str) -> anyhow::Result<Child> {
        let mut command = self.command();
        command
            .args(["logs", "-f", "--timestamps", "--tail", "200", name])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command.spawn().context("spawn docker logs")
    }

    pub async fn is_running(&self, name: &str) -> bool {
        let output = self
            .command()
            .args(["inspect", name, "--format", "{{.State.Running}}"])
            .output()
            .await;
        match output {
            Ok(output) => {
                output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "true"
            }
            Err(_) => false,
        }
    }
}

pub fn container_name(node_id: uuid::Uuid, instance_id: uuid::Uuid) -> String {
    format!("opsweave-{node_id}-{instance_id}")
}
