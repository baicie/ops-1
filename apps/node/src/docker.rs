use anyhow::{anyhow, Context};
use opsweave_contracts::DesiredWorkload;
use std::path::Path;
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
        command.kill_on_drop(true);
        command
    }

    pub async fn version(&self) -> anyhow::Result<String> {
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            self.command()
                .arg("version")
                .arg("--format")
                .arg("{{.Server.Version}}")
                .output(),
        )
        .await
        .context("docker version timed out")?
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
        self.run_with_timeout(args, 60).await
    }

    async fn run_with_timeout(&self, args: &[&str], seconds: u64) -> anyhow::Result<String> {
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(seconds),
            self.command().args(args).output(),
        )
        .await
        .with_context(|| format!("docker {} timed out after {seconds}s", args.join(" ")))?
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
        self.run_with_timeout(&["pull", image_ref], 300).await?;
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
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            self.command()
                .args([
                    "inspect",
                    name,
                    "--format",
                    "{{.Id}}|{{.State.Running}}|{{.Config.Image}}",
                ])
                .output(),
        )
        .await
        .context("docker inspect timed out")?
        .context("run docker inspect")?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let lower = stderr.to_ascii_lowercase();
            if lower.contains("no such object") || lower.contains("no such container") {
                return Ok(None);
            }
            return Err(anyhow!("docker inspect failed: {}", stderr.trim()));
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
            .run_with_timeout(
                &[
                    "inspect",
                    name,
                    "--format",
                    "{{json .NetworkSettings.Ports}}",
                ],
                5,
            )
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
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            self.command().args(["rm", "-f", name]).output(),
        )
        .await;
    }

    pub async fn create_and_start(
        &self,
        workload: &DesiredWorkload,
        image_ref: &str,
        container_port: u16,
        node_id: uuid::Uuid,
        extra_env: &std::collections::BTreeMap<String, String>,
        token_file: Option<&Path>,
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
        let mut args: Vec<String> = vec![
            "create".to_string(),
            "--name".to_string(),
            name.clone(),
            "--label".to_string(),
            "opsweave.managed=true".to_string(),
            "--label".to_string(),
            instance_label.clone(),
            "--label".to_string(),
            deployment_label.clone(),
            "--label".to_string(),
            plugin_label.clone(),
            "--label".to_string(),
            version_label.clone(),
            "--label".to_string(),
            node_label.clone(),
            "--memory".to_string(),
            memory.clone(),
            "--memory-swap".to_string(),
            memory_swap.clone(),
            "--cpus".to_string(),
            cpu.clone(),
            "--pids-limit".to_string(),
            "256".to_string(),
            "--cap-drop".to_string(),
            "ALL".to_string(),
            "--security-opt".to_string(),
            "no-new-privileges".to_string(),
            "--user".to_string(),
            "65532:65532".to_string(),
            "--init".to_string(),
            "--read-only".to_string(),
            "--tmpfs".to_string(),
            tmpfs.clone(),
            "--restart".to_string(),
            "no".to_string(),
            "--publish".to_string(),
            publish.clone(),
            "--env".to_string(),
            env_instance.clone(),
            "--env".to_string(),
            env_plugin.clone(),
            "--env".to_string(),
            env_version.clone(),
        ];
        for (key, value) in extra_env {
            if !key.is_empty() && key.len() <= 128 && value.len() <= 8192 {
                args.push("--env".to_string());
                args.push(format!("{key}={value}"));
            }
        }
        if let Some(token_file) = token_file {
            let token_dir = token_file
                .parent()
                .ok_or_else(|| anyhow!("token file has no parent directory"))?;
            args.push("--mount".to_string());
            args.push(format!(
                "type=bind,source={},target=/run/opsweave,readonly",
                token_dir.display()
            ));
        }
        args.push(image_ref.to_string());
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let args = arg_refs;
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
            .run_with_timeout(
                &[
                    "ps",
                    "-a",
                    "--filter",
                    "label=opsweave.managed=true",
                    "--filter",
                    &filter,
                    "--format",
                    "{{.Names}}",
                ],
                10,
            )
            .await?;
        Ok(raw
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect())
    }

    pub async fn stop_and_remove(&self, name: &str) -> anyhow::Result<()> {
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            self.command().args(["stop", "--time", "5", name]).output(),
        )
        .await;
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            self.command().args(["rm", "-f", name]).output(),
        )
        .await;
        if let Some(info) = self.inspect(name).await? {
            if info.running {
                anyhow::bail!("container {name} is still running after stop/remove");
            }
            anyhow::bail!("container {name} still exists after stop/remove");
        }
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
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            self.command()
                .args(["inspect", name, "--format", "{{.State.Running}}"])
                .output(),
        )
        .await;
        match output {
            Ok(Ok(output)) => {
                output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "true"
            }
            _ => false,
        }
    }
}

pub fn container_name(node_id: uuid::Uuid, instance_id: uuid::Uuid) -> String {
    format!("opsweave-{node_id}-{instance_id}")
}

#[cfg(test)]
mod tests {

    use super::DockerAdapter;

    #[tokio::test]
    async fn stop_and_remove_reports_a_surviving_container() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("docker");
        std::fs::write(
            &script,
            "#!/bin/sh\ncase \"$1\" in\n  inspect) echo 'surviving|true|fake'; exit 0 ;;\n  *) exit 0 ;;\nesac\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let adapter = DockerAdapter::new(
            script.to_string_lossy().into_owned(),
            "unix://unused".into(),
        );
        let error = adapter.stop_and_remove("surviving").await.unwrap_err();
        assert!(error.to_string().contains("still running"));
    }
}

#[cfg(test)]
mod run_tests {
    use super::DockerAdapter;
    #[tokio::test]
    async fn list_managed_simple_command() {
        let adapter = DockerAdapter::new("/usr/bin/true".into(), "unix://unused".into());
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            adapter.list_managed(uuid::Uuid::new_v4()),
        )
        .await
        .expect("list hung");
        assert!(result.is_ok(), "{result:?}");
    }

    #[tokio::test]
    async fn run_simple_command() {
        let adapter = DockerAdapter::new("/usr/bin/true".into(), "unix://unused".into());
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), adapter.run(&["x"]))
            .await
            .expect("inner run hung");
        assert!(result.is_ok());
    }
}
