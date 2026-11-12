use anyhow::{anyhow, Context};
use opsweave_contracts::DesiredWorkload;
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Stdio;
use tokio::process::{Child, Command};

/// Environment entries are passed as individual `docker create --env` argv
/// elements. Keep each one well below Linux's 128 KiB single-argument limit
/// while leaving room for multi-workspace secret/binding maps. Above these
/// limits the deployment fails with `NODE_PLUGIN_ENV_TOO_LARGE`; an instance
/// never starts with part of its configuration silently missing.
const MAX_ENV_ENTRY_BYTES: usize = 32 * 1024;
const MAX_ENV_TOTAL_BYTES: usize = 256 * 1024;
/// Docker stderr is untrusted input. It is kept for diagnosis, but secret
/// values from the command line are masked and the remainder is bounded.
const MAX_STDERR_CHARS: usize = 4096;

/// A command line safe to put in an error, log or deployment status.
///
/// `docker create` carries plugin secrets through `--env`, and the error context
/// used to join every argument, so a create failure wrote
/// `OPSWEAVE_PLUGIN_SECRETS=<token>` into the Node log, the instance status and
/// the Kernel's `last_error`. Values are never logged: every `--env` value is
/// redacted, and a secret-shaped `KEY=VALUE` is redacted even without the flag.
fn redacted_command(args: &[&str]) -> String {
    let mut out = Vec::with_capacity(args.len());
    let mut redact_next = false;
    for arg in args {
        if redact_next {
            out.push("[redacted]".to_string());
            redact_next = false;
            continue;
        }
        if *arg == "--env" || *arg == "--build-arg" {
            out.push((*arg).to_string());
            redact_next = true;
            continue;
        }
        if let Some((key, _)) = arg.split_once('=') {
            let key_upper = key.to_ascii_uppercase();
            if key_upper.starts_with("OPSWEAVE_")
                && (key_upper.contains("SECRET")
                    || key_upper.contains("TOKEN")
                    || key_upper.contains("PASSWORD"))
            {
                out.push(format!("{key}=[redacted]"));
                continue;
            }
        }
        out.push((*arg).to_string());
    }
    out.join(" ")
}

/// Values that must never be echoed from Docker's stderr.
///
/// Every `--env`/`--build-arg` value is collected (plus secret-shaped
/// `KEY=VALUE` arguments outside those flags), and JSON containers are walked
/// so an individual token is masked even when stderr quotes only that token.
/// Values shorter than 8 bytes are skipped because masking e.g. `1` would
/// destroy diagnostics; such a value has too little entropy to be a useful
/// secret on its own.
fn sensitive_values(args: &[&str]) -> Vec<String> {
    let mut values = Vec::new();
    let mut capture_next = false;
    for arg in args {
        if capture_next {
            let value = arg.split_once('=').map(|(_, value)| value).unwrap_or(arg);
            collect_secret_text(value, &mut values);
            capture_next = false;
            continue;
        }
        if *arg == "--env" || *arg == "--build-arg" {
            capture_next = true;
            continue;
        }
        if let Some((key, value)) = arg.split_once('=') {
            if is_secret_key(key) {
                collect_secret_text(value, &mut values);
            }
        }
    }
    values.retain(|value| value.len() >= 8);
    values.sort_by_key(|value| std::cmp::Reverse(value.len()));
    values.dedup();
    values
}

fn is_secret_key(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    key.starts_with("OPSWEAVE_")
        && (key.contains("SECRET")
            || key.contains("TOKEN")
            || key.contains("PASSWORD")
            || key.contains("CREDENTIAL")
            || key.ends_with("DATABASE_URL"))
}

fn collect_secret_text(value: &str, out: &mut Vec<String>) {
    if value.len() >= 8 {
        out.push(value.to_string());
    }
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(value) {
        collect_json_strings(&parsed, out);
    }
}

fn collect_json_strings(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::String(text) if text.len() >= 8 => out.push(text.clone()),
        serde_json::Value::Array(items) => {
            for item in items {
                collect_json_strings(item, out);
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values() {
                collect_json_strings(item, out);
            }
        }
        _ => {}
    }
}

fn redact_sensitive(text: &str, values: &[String]) -> String {
    let mut redacted = text.to_string();
    for value in values {
        redacted = redacted.replace(value.as_str(), "[redacted]");
    }
    redacted
}

fn bounded(text: &str) -> String {
    if text.chars().count() <= MAX_STDERR_CHARS {
        return text.to_string();
    }
    let mut truncated: String = text.chars().take(MAX_STDERR_CHARS).collect();
    truncated.push_str("…[truncated]");
    truncated
}

fn docker_failure(
    args: &[&str],
    status: &std::process::ExitStatus,
    stderr: &[u8],
) -> anyhow::Error {
    let action = args.first().copied().unwrap_or("command");
    let exit = status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "signal".to_string());
    let detail = redact_sensitive(
        String::from_utf8_lossy(stderr).trim(),
        &sensitive_values(args),
    );
    let detail = bounded(&detail);
    if detail.is_empty() {
        return anyhow!("docker {action} failed (exit {exit}): no stderr");
    }
    anyhow!("docker {action} failed (exit {exit}): {detail}")
}

fn validate_env_budget(extra_env: &BTreeMap<String, String>) -> anyhow::Result<()> {
    let mut total = 0usize;
    for (key, value) in extra_env {
        if key.is_empty() || key.len() > 128 {
            return Err(anyhow!(
                "NODE_PLUGIN_ENV_INVALID_KEY: env key {key:?} is empty or longer than 128 bytes"
            ));
        }
        total = total.saturating_add(key.len() + value.len());
        if value.len() > MAX_ENV_ENTRY_BYTES {
            return Err(anyhow!(
                "NODE_PLUGIN_ENV_TOO_LARGE: {key} is {} bytes, the per-entry limit is {MAX_ENV_ENTRY_BYTES} bytes; the instance was not started because it would run without this configuration",
                value.len()
            ));
        }
    }
    if total > MAX_ENV_TOTAL_BYTES {
        return Err(anyhow!(
            "NODE_PLUGIN_ENV_TOO_LARGE: environment totals {total} bytes, the limit is {MAX_ENV_TOTAL_BYTES} bytes; the instance was not started"
        ));
    }
    Ok(())
}

/// The label that makes a container ours.
///
/// `opsweave.node-id` is not ownership. It survives a database restore, a
/// copied state directory and any test that reuses one, so two unrelated
/// installations legitimately carry the same value - and a sweep scoped to
/// "my node id" then deletes the other installation's containers.
///
/// `opsweave.installation-id` is minted once per *installation* (the Node's
/// state directory, which is also where its enrolment identity lives) and
/// travels with every container it creates. It is deliberately NOT stored in
/// the database: restoring a database is exactly one of the ways two installs
/// come to share a node id, so a value kept there would be restored along with
/// it and prove nothing.
pub const INSTALLATION_LABEL: &str = "opsweave.installation-id";

#[derive(Debug, Clone)]
pub struct DockerAdapter {
    pub binary: String,
    pub host: String,
    /// This installation's ownership token, or `None` when the caller has not
    /// established one. `None` never means "own everything": every removal path
    /// refuses rather than acting on an unprovable target.
    pub installation_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ContainerInfo {
    pub id: String,
    pub running: bool,
    pub image: String,
    pub host_port: Option<u16>,
}

/// Why a container may or may not be acted on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ownership {
    /// Created by this installation: safe to stop and remove.
    Ours,
    /// Exists, but belongs to another installation (or predates the label).
    Foreign,
    /// No such container.
    Absent,
}

impl DockerAdapter {
    pub fn new(binary: String, host: String) -> Self {
        Self {
            binary,
            host,
            installation_id: None,
        }
    }

    pub fn with_installation_id(mut self, installation_id: impl Into<String>) -> Self {
        self.installation_id = Some(installation_id.into());
        self
    }

    /// The `--label` argument this installation stamps on every container.
    pub fn installation_label(&self) -> Option<String> {
        self.installation_id
            .as_ref()
            .map(|id| format!("{INSTALLATION_LABEL}={id}"))
    }

    /// Decide whether `name` belongs to this installation.
    ///
    /// A container without the label is `Foreign`, not `Ours`: an unlabelled
    /// container is either from another installation or from a version that
    /// predates this label, and neither is safe to delete on a guess. Such a
    /// container is reported by name so an operator can migrate or remove it
    /// deliberately; see `03h-lifecycle-correctness.md` for the migration note.
    pub async fn ownership_of(&self, name: &str) -> anyhow::Result<Ownership> {
        let Some(ours) = self.installation_id.as_deref() else {
            // Without an identity we cannot distinguish ours from anyone else's.
            // Report it as foreign rather than pretending to own it: the caller
            // turns that into a refusal, never into a delete.
            let exists = self.inspect(name).await?.is_some();
            return Ok(if exists {
                Ownership::Foreign
            } else {
                Ownership::Absent
            });
        };
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            self.command()
                .args([
                    "inspect",
                    name,
                    "--format",
                    &format!("{{{{index .Config.Labels \"{INSTALLATION_LABEL}\"}}}}"),
                ])
                .output(),
        )
        .await
        .context("docker inspect ownership timed out")?
        .context("run docker inspect ownership")?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let lower = stderr.to_ascii_lowercase();
            if lower.contains("no such object") || lower.contains("no such container") {
                return Ok(Ownership::Absent);
            }
            return Err(anyhow!(
                "docker inspect failed while checking ownership of {name}: {}",
                bounded(stderr.trim())
            ));
        }
        let found = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(if found == ours {
            Ownership::Ours
        } else {
            Ownership::Foreign
        })
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
                bounded(String::from_utf8_lossy(&output.stderr).trim())
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
        .with_context(|| {
            format!(
                "docker {} timed out after {seconds}s",
                redacted_command(args)
            )
        })?
        .with_context(|| format!("run docker {}", redacted_command(args)))?;
        if !output.status.success() {
            return Err(docker_failure(args, &output.status, &output.stderr));
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
            return Err(anyhow!("docker inspect failed: {}", bounded(stderr.trim())));
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

    /// Remove `name` before recreating it - but only if this installation owns it.
    ///
    /// The name is derived from `node_id` and `instance_id` only, and both can
    /// be reproduced by a second installation (a restored database carries the
    /// node row; the instance rows come back with it). A bare `docker rm -f`
    /// here therefore destroys the other installation's running container and
    /// hands its traffic to a container this one just created.
    ///
    /// Returns the outcome so the caller can distinguish "nothing was there"
    /// from "something was there and I refuse to touch it". A refusal is an
    /// error, not a silent skip: continuing would make `docker create` fail on
    /// the duplicate name anyway, with a message that does not explain why.
    pub async fn remove_owned_if_present(&self, name: &str) -> anyhow::Result<Ownership> {
        match self.ownership_of(name).await? {
            Ownership::Absent => Ok(Ownership::Absent),
            Ownership::Foreign => Ok(Ownership::Foreign),
            Ownership::Ours => {
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    self.command().args(["rm", "-f", name]).output(),
                )
                .await;
                // Removing is the whole point of the call, so verify rather than
                // trusting the exit status of a `rm -f` that reports "no such
                // container" and "still in use" the same way to us.
                match self.ownership_of(name).await? {
                    Ownership::Absent => Ok(Ownership::Ours),
                    _ => anyhow::bail!(
                        "CONTAINER_OWNERSHIP_BLOCKED: {name} belongs to this installation \
                         ({INSTALLATION_LABEL}) but could not be removed; refusing to create \
                         over it"
                    ),
                }
            }
        }
    }

    pub async fn create_and_start(
        &self,
        workload: &DesiredWorkload,
        image_ref: &str,
        container_port: u16,
        node_id: uuid::Uuid,
        extra_env: &std::collections::BTreeMap<String, String>,
        token_file: Option<&Path>,
        extra_labels: &[String],
    ) -> anyhow::Result<String> {
        // Eight parameters, all of them inputs to a single docker create. The
        // caller-supplied labels are grouped with env and the token file as
        // "what this call adds to the container" rather than being a separate
        // concept; they are kept as distinct parameters because merging them
        // would need a new type purely to satisfy an arity lint.
        #![allow(clippy::too_many_arguments)]
        validate_env_budget(extra_env)?;
        let name = container_name(node_id, workload.instance_id);
        // Ownership is decided before anything is removed. `Foreign` is a hard
        // failure: the installation that owns this name is running, and taking
        // it over would be exactly the cross-installation collision this guard
        // exists to prevent.
        match self.remove_owned_if_present(&name).await? {
            Ownership::Absent | Ownership::Ours => {}
            Ownership::Foreign => {
                anyhow::bail!(
                    "CONTAINER_OWNERSHIP_CONFLICT: a container named {name} already exists and \
                     was not created by this installation (no matching {INSTALLATION_LABEL}). \
                     It was left running. Another OpsWeave installation sharing this node id \
                     owns it - give each installation its own node identity, or remove that \
                     container deliberately if it is a leftover."
                )
            }
        }
        let installation_label = self.installation_label();
        if installation_label.is_none() {
            anyhow::bail!(
                "CONTAINER_OWNERSHIP_UNPROVEN: this Node has no installation identity, so it \
                 cannot mark the container it is about to create; a container without \
                 {INSTALLATION_LABEL} cannot be safely cleaned up later"
            );
        }
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
        // Caller-supplied labels, so an install can mark its own containers even
        // when another install shares its node id (a restored database, a copied
        // state dir). See OPSWEAVE_CONTAINER_LABELS.
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
        for label in extra_labels {
            // Reject a malformed label rather than letting docker create the
            // container with a label nobody can query for later.
            if !label.contains('=') {
                anyhow::bail!("container label {label:?} is not key=value");
            }
            args.push("--label".to_string());
            args.push(label.clone());
        }
        if let Some(label) = installation_label {
            args.push("--label".to_string());
            args.push(label);
        }
        for (key, value) in extra_env {
            args.push("--env".to_string());
            args.push(format!("{key}={value}"));
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

    /// Every container this *installation* manages on `node_id`.
    ///
    /// Both filters are required. The node id alone matches a second install
    /// that inherited the same identity through a restored database or a copied
    /// state directory; the installation label is what makes the result ours.
    /// Without an installation identity the set is empty rather than
    /// everything - a sweep that cannot prove ownership must remove nothing.
    pub async fn list_managed(&self, node_id: uuid::Uuid) -> anyhow::Result<Vec<String>> {
        // Not an empty list: an empty list reads as "nothing left to clean up",
        // which would let quarantine report a success it never established. A
        // node that cannot prove ownership has to say so and stay blocked.
        let installation = self.installation_id.as_deref().ok_or_else(|| {
            anyhow!(
                "CONTAINER_OWNERSHIP_UNPROVEN: this Node has no installation identity, so it \
                 cannot enumerate the containers it owns; refusing to sweep"
            )
        })?;
        let node_filter = format!("label=opsweave.node-id={node_id}");
        let installation_filter = format!("label={INSTALLATION_LABEL}={installation}");
        let raw = self
            .run_with_timeout(
                &[
                    "ps",
                    "-a",
                    "--filter",
                    "label=opsweave.managed=true",
                    "--filter",
                    &node_filter,
                    "--filter",
                    &installation_filter,
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

    /// Stop and remove `name`, but only if this installation owns it.
    ///
    /// A foreign or absent container is not an error here: callers use this on
    /// best-effort cleanup paths (`cleanup`, `cleanup_orphans`, quarantine) where
    /// "it was not ours" is a correct no-op. What must never happen is deleting
    /// somebody else's container because it happened to share a name.
    pub async fn stop_and_remove_owned(&self, name: &str) -> anyhow::Result<Ownership> {
        match self.ownership_of(name).await? {
            Ownership::Absent => return Ok(Ownership::Absent),
            Ownership::Foreign => {
                tracing::warn!(
                    container = %name,
                    "refusing to stop a container this installation does not own"
                );
                return Ok(Ownership::Foreign);
            }
            Ownership::Ours => {}
        }
        self.stop_and_remove(name).await?;
        Ok(Ownership::Ours)
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

/// A test that writes an executable script and runs it immediately can race a
/// sibling test's `fork`/`exec`: on Linux the fresh inode stays writable in the
/// forked child until it execs, and `execve` then fails with ETXTBSY. This is a
/// harness race, not product behaviour; the product never retries Docker. The
/// retry is bounded, and only that OS error is retried.
#[cfg(test)]
fn is_text_file_busy(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.to_string().contains("Text file busy"))
}

#[cfg(test)]
async fn retry_exec_busy<T, F, Fut>(mut op: F) -> anyhow::Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<T>>,
{
    let mut attempts = 0u32;
    loop {
        match op().await {
            Ok(value) => return Ok(value),
            Err(error) if attempts < 20 && is_text_file_busy(&error) => {
                attempts += 1;
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(test)]
mod tests {

    use super::{retry_exec_busy, DockerAdapter};

    // ---- container ownership -------------------------------------------------
    //
    // These run against a fake `docker` binary that keeps a real little container
    // store on disk, rather than asserting the shape of an argv vector. The
    // property under test is behavioural - "does the foreign container survive
    // the call?" - and an argv assertion cannot answer that: it passes just as
    // happily when `rm -f` is still there a line later.

    use super::{Ownership, INSTALLATION_LABEL};

    /// A `docker` stand-in with a store at `$STORE/<name>/<field>`.
    ///
    /// Supports exactly what DockerAdapter calls: `inspect --format` for the
    /// three formats it uses, `create`, `start`, `rm`, `stop`, `ps`. Argument
    /// order is ignored; it searches for `--format` and the container name.
    fn fake_docker(dir: &std::path::Path) -> (String, std::path::PathBuf) {
        let store = dir.join("store");
        std::fs::create_dir_all(&store).unwrap();
        let script = dir.join("docker");
        // Keep the shell simple: the adapter always puts the container name last
        // for inspect/rm/stop/start, and after `--name` for create.
        let body = format!(
            r#"#!/bin/sh
STORE="{store}"
LABEL_KEY="{inst}"
fmt=""; name=""; expect=""
for a in "$@"; do
  case "$expect" in
    fmtv)   fmt="$a"; expect=""; continue ;;
    name)   name="$a"; expect=""; continue ;;
    value)  expect=""; continue ;;
  esac
  case "$a" in
    --format) expect=fmtv ;;
    --name)   case "$1" in create) expect=name ;; esac ;;
    --env|--label|--filter|--mount|--publish|--memory|--memory-swap|--cpus|--time|--user) expect=value ;;
    --pids-limit|--cap-drop|--security-opt|--tmpfs|--restart) expect=value ;;
  esac
done
# Positional container name: last argument that is not a flag. Flags with
# values have already been skipped above by the `expect` machine, so scanning
# again with it is enough for inspect/rm/stop/start.
positional=""; expect=""
for a in "$@"; do
  case "$expect" in
    fmtv|name|value) expect=""; continue ;;
  esac
  case "$a" in
    --format) expect=fmtv ;;
    --name)   expect=name ;;
    --env|--label|--filter|--mount|--publish|--memory|--memory-swap|--cpus|--time|--user) expect=value ;;
    --pids-limit|--cap-drop|--security-opt|--tmpfs|--restart) expect=value ;;
    -*) ;;
    *) positional="$a" ;;
  esac
done
[ -n "$name" ] || name="$positional"

case "$1" in
  inspect)
    [ -d "$STORE/$name" ] || {{ echo "Error: No such object: $name" >&2; exit 1; }}
    case "$fmt" in
      *Config.Labels*)         cat "$STORE/$name/label" 2>/dev/null ;;
      *State.Running*)         cat "$STORE/$name/running" 2>/dev/null || echo true ;;
      *NetworkSettings.Ports*) echo '{{"80/tcp":[{{"HostIp":"127.0.0.1","HostPort":"32768"}}]}}' ;;
      *) printf '%s|true|%s\n' "$(cat "$STORE/$name/id" 2>/dev/null)" "$(cat "$STORE/$name/image" 2>/dev/null)" ;;
    esac
    ;;
  create)
    if [ -d "$STORE/$name" ]; then
      echo "Error: Conflict. The container name \"/$name\" is already in use" >&2
      exit 125
    fi
    mkdir -p "$STORE/$name"
    echo "cid-$name" > "$STORE/$name/id"
    echo "true" > "$STORE/$name/running"
    : > "$STORE/$name/label"
    prev=""
    for a in "$@"; do
      case "$prev" in
        --label)
          case "$a" in
            "$LABEL_KEY"=*) printf '%s' "${{a#*=}}" > "$STORE/$name/label" ;;
          esac
          ;;
      esac
      prev="$a"
    done
    printf '%s' "$name"
    ;;
  start) : ;;
  stop)  if [ -d "$STORE/$name" ]; then echo false > "$STORE/$name/running"; fi ;;
  rm)    rm -rf "$STORE/$name" ;;
  ps)
    for d in "$STORE"/*; do
      [ -d "$d" ] || continue
      keep=1
      prev=""
      for a in "$@"; do
        case "$prev" in
          --filter)
            case "$a" in
              "label=$LABEL_KEY"=*)
                want="${{a#label=$LABEL_KEY=}}"
                have=$(cat "$d/label" 2>/dev/null || echo "")
                [ "$want" = "$have" ] || keep=0
                ;;
            esac
            ;;
        esac
        prev="$a"
      done
      if [ "$keep" = "1" ]; then basename "$d"; fi
    done
    ;;
  version) echo 29.0.0 ;;
  *) : ;;
esac
exit 0
"#,
            store = store.display(),
            inst = INSTALLATION_LABEL
        );
        std::fs::write(&script, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        (script.to_string_lossy().into_owned(), store)
    }

    #[tokio::test]
    async fn a_foreign_container_with_the_same_name_is_never_removed() {
        let dir = tempfile::tempdir().unwrap();
        let (binary, store) = fake_docker(dir.path());
        let name = "opsweave-shared-name";

        // The other installation already runs a container under this name.
        std::fs::create_dir_all(store.join(name)).unwrap();
        std::fs::write(store.join(name).join("id"), "foreign-id").unwrap();
        std::fs::write(store.join(name).join("running"), "true").unwrap();
        std::fs::write(store.join(name).join("label"), "install-b").unwrap();

        let ours =
            DockerAdapter::new(binary, "unix://unused".into()).with_installation_id("install-a");
        let outcome = retry_exec_busy(|| ours.remove_owned_if_present(name))
            .await
            .unwrap();

        assert_eq!(outcome, Ownership::Foreign, "it is not ours to remove");
        assert!(
            store.join(name).join("id").exists(),
            "the other installation's container was deleted"
        );
        assert_eq!(
            std::fs::read_to_string(store.join(name).join("id")).unwrap(),
            "foreign-id",
            "the surviving container is not the original one"
        );
        assert_eq!(
            std::fs::read_to_string(store.join(name).join("label")).unwrap(),
            "install-b",
            "the surviving container's ownership label changed"
        );
    }

    #[tokio::test]
    async fn our_own_container_is_removed_and_a_missing_one_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let (binary, store) = fake_docker(dir.path());
        let name = "opsweave-ours";
        std::fs::create_dir_all(store.join(name)).unwrap();
        std::fs::write(store.join(name).join("id"), "ours-id").unwrap();
        std::fs::write(store.join(name).join("running"), "true").unwrap();
        std::fs::write(store.join(name).join("label"), "install-a").unwrap();

        let ours =
            DockerAdapter::new(binary, "unix://unused".into()).with_installation_id("install-a");
        assert_eq!(
            retry_exec_busy(|| ours.remove_owned_if_present(name))
                .await
                .unwrap(),
            Ownership::Ours
        );
        assert!(
            !store.join(name).exists(),
            "our own stale container should have been removed"
        );
        // Absent is a normal state on the first deploy.
        assert_eq!(
            retry_exec_busy(|| ours.remove_owned_if_present(name))
                .await
                .unwrap(),
            Ownership::Absent
        );
    }

    #[tokio::test]
    async fn create_refuses_a_name_another_installation_owns() {
        use opsweave_contracts::{
            DesiredAction, DesiredBackend, DesiredWorkload, ResourceRequirements,
        };
        let dir = tempfile::tempdir().unwrap();
        let (binary, store) = fake_docker(dir.path());
        let node_id = uuid::Uuid::new_v4();
        let instance_id = uuid::Uuid::new_v4();
        let name = super::container_name(node_id, instance_id);
        std::fs::create_dir_all(store.join(&name)).unwrap();
        std::fs::write(store.join(&name).join("id"), "foreign-id").unwrap();
        std::fs::write(store.join(&name).join("label"), "install-b").unwrap();

        let ours =
            DockerAdapter::new(binary, "unix://unused".into()).with_installation_id("install-a");
        let workload = DesiredWorkload {
            instance_id,
            deployment_id: uuid::Uuid::new_v4(),
            plugin_id: "dev.opsweave.hello".into(),
            version: "0.0.1".into(),
            generation: 1,
            action: DesiredAction::Start,
            backend: DesiredBackend {
                image_ref: "example/image@sha256:abc".into(),
                container_port: 80,
                capability_digest: "sha256:abc".into(),
                readiness_path: "/ready".into(),
                liveness_path: "/live".into(),
                startup_path: None,
                api_prefix: "/api".into(),
            },
            resources: ResourceRequirements {
                cpu_millis: 500,
                memory_mib: 128,
            },
            labels: Default::default(),
        };
        let empty_env = Default::default();
        let error = retry_exec_busy(|| {
            ours.create_and_start(
                &workload,
                "example/image@sha256:abc",
                80,
                node_id,
                &empty_env,
                None,
                &[],
            )
        })
        .await
        .unwrap_err();
        let text = format!("{error:#}");
        assert!(text.contains("CONTAINER_OWNERSHIP_CONFLICT"), "{text}");
        assert!(
            store.join(&name).join("id").exists(),
            "the create path deleted another installation's container"
        );
        assert_eq!(
            std::fs::read_to_string(store.join(&name).join("label")).unwrap(),
            "install-b"
        );
    }

    #[tokio::test]
    async fn list_managed_requires_the_installation_label() {
        let dir = tempfile::tempdir().unwrap();
        let (binary, store) = fake_docker(dir.path());
        let node_id = uuid::Uuid::new_v4();
        // Same node id, two installations.
        for (name, label) in [("a-owned", "install-a"), ("b-owned", "install-b")] {
            std::fs::create_dir_all(store.join(name)).unwrap();
            std::fs::write(store.join(name).join("label"), label).unwrap();
        }
        let ours = DockerAdapter::new(binary.clone(), "unix://unused".into())
            .with_installation_id("install-a");
        let names = retry_exec_busy(|| ours.list_managed(node_id))
            .await
            .unwrap();
        assert_eq!(names, vec!["a-owned".to_string()]);

        // With no identity the sweep must ERROR, not return an empty list: an
        // empty list is indistinguishable from "clean", and quarantine would
        // then report a success it never established.
        let anonymous = DockerAdapter::new(binary, "unix://unused".into());
        let error = retry_exec_busy(|| anonymous.list_managed(node_id))
            .await
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("CONTAINER_OWNERSHIP_UNPROVEN"),
            "unexpected error: {error:#}"
        );
    }

    #[tokio::test]
    async fn stop_and_remove_owned_leaves_a_foreign_container_running() {
        let dir = tempfile::tempdir().unwrap();
        let (binary, store) = fake_docker(dir.path());
        let name = "opsweave-foreign";
        std::fs::create_dir_all(store.join(name)).unwrap();
        std::fs::write(store.join(name).join("id"), "foreign-id").unwrap();
        std::fs::write(store.join(name).join("running"), "true").unwrap();
        std::fs::write(store.join(name).join("label"), "install-b").unwrap();

        let ours =
            DockerAdapter::new(binary, "unix://unused".into()).with_installation_id("install-a");
        assert_eq!(
            retry_exec_busy(|| ours.stop_and_remove_owned(name))
                .await
                .unwrap(),
            Ownership::Foreign
        );
        assert_eq!(
            std::fs::read_to_string(store.join(name).join("running")).unwrap(),
            "true",
            "a foreign container was stopped"
        );
        assert!(store.join(name).join("id").exists());
    }

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
        let error = retry_exec_busy(|| adapter.stop_and_remove("surviving"))
            .await
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("still running"),
            "unexpected stop/remove error: {error:#}"
        );
    }
}

#[cfg(test)]
mod run_tests {
    use super::{
        redacted_command, retry_exec_busy, validate_env_budget, DockerAdapter, MAX_ENV_ENTRY_BYTES,
    };
    use std::collections::BTreeMap;

    #[test]
    fn docker_error_context_never_contains_env_values() {
        let args = [
            "create",
            "--env",
            "OPSWEAVE_PLUGIN_SECRETS={\"ws\":{\"secretref:x\":\"super-secret-token\"}}",
            "--env",
            "OPSWEAVE_INSTANCE_ID=123",
            "image",
        ];
        let redacted = redacted_command(&args);
        assert!(!redacted.contains("super-secret-token"));
        assert!(!redacted.contains("OPSWEAVE_INSTANCE_ID=123"));
        assert!(redacted.contains("--env [redacted]"));
    }
    #[tokio::test]
    async fn docker_create_stderr_is_redacted_before_it_reaches_logs() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("docker");
        std::fs::write(
            &script,
            r#"#!/bin/sh
case "$1" in
  create)
    echo 'daemon: invalid env OPSWEAVE_PLUGIN_SECRETS={"ws":{"secretref:zabbix/main":"super-secret-token"}}' >&2
    echo 'daemon: adapter key adapter-signing-secret-value rejected' >&2
    exit 125
    ;;
  *) exit 0 ;;
esac
"#,
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
        let args = [
            "create",
            "--env",
            "OPSWEAVE_PLUGIN_SECRETS={\"ws\":{\"secretref:zabbix/main\":\"super-secret-token\"}}",
            "--env",
            "OPSWEAVE_EVIDENCE_ADAPTERS={\"zabbix\":\"adapter-signing-secret-value\"}",
            "image",
        ];
        let error = format!(
            "{:#}",
            retry_exec_busy(|| adapter.run_with_timeout(&args, 5))
                .await
                .unwrap_err()
        );
        assert!(!error.contains("super-secret-token"), "{error}");
        assert!(!error.contains("adapter-signing-secret-value"), "{error}");
        assert!(error.contains("docker create failed"), "{error}");
        assert!(error.contains("125"), "{error}");
        assert!(
            error.contains("invalid env"),
            "diagnostics were destroyed: {error}"
        );
        assert!(error.contains("[redacted]"), "{error}");
    }

    #[test]
    fn one_oversized_env_entry_fails_the_deployment() {
        let mut env = BTreeMap::new();
        env.insert(
            "OPSWEAVE_PLUGIN_SECRETS".to_string(),
            format!("super-secret-token-{}", "x".repeat(MAX_ENV_ENTRY_BYTES)),
        );
        let error = validate_env_budget(&env).unwrap_err().to_string();
        assert!(error.contains("NODE_PLUGIN_ENV_TOO_LARGE"), "{error}");
        assert!(error.contains("OPSWEAVE_PLUGIN_SECRETS"), "{error}");
        assert!(!error.contains("super-secret-token"), "{error}");
    }

    #[test]
    fn total_env_budget_fails_instead_of_dropping_entries() {
        let mut env = BTreeMap::new();
        for index in 0..9 {
            env.insert(format!("ENTRY_{index}"), "x".repeat(30 * 1024));
        }
        let error = validate_env_budget(&env).unwrap_err().to_string();
        assert!(error.contains("NODE_PLUGIN_ENV_TOO_LARGE"), "{error}");
        assert!(error.contains("totals"), "{error}");
    }

    #[test]
    fn valid_env_and_invalid_keys_are_distinguished() {
        let mut env = BTreeMap::new();
        env.insert(
            "OPSWEAVE_PLUGIN_SECRETS".to_string(),
            "{\"a\":\"b\"}".to_string(),
        );
        assert!(validate_env_budget(&env).is_ok());

        let mut invalid = BTreeMap::new();
        invalid.insert(String::new(), "value".to_string());
        let error = validate_env_budget(&invalid).unwrap_err().to_string();
        assert!(error.contains("NODE_PLUGIN_ENV_INVALID_KEY"), "{error}");
    }

    #[tokio::test]
    async fn list_managed_simple_command() {
        let adapter = DockerAdapter::new("/usr/bin/true".into(), "unix://unused".into())
            .with_installation_id(uuid::Uuid::new_v4().to_string());
        // The timeout exists to catch a hang, not to measure latency: 2s was
        // flaky on loaded CI runners where fork/exec of the fake binary can
        // take longer than the assertion budget.
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            adapter.list_managed(uuid::Uuid::new_v4()),
        )
        .await
        .expect("list hung");
        assert!(result.is_ok(), "{result:?}");
    }

    #[tokio::test]
    async fn run_simple_command() {
        let adapter = DockerAdapter::new("/usr/bin/true".into(), "unix://unused".into());
        let result = tokio::time::timeout(std::time::Duration::from_secs(15), adapter.run(&["x"]))
            .await
            .expect("inner run hung");
        assert!(result.is_ok());
    }
}
