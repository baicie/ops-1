//! Immutable plugin bundle handling for OpsWeave 0.0.1.
//!
//! A bundle is a ZIP with a canonical `manifest.json`, a `payload-index.json`
//! (canonical JSON array of every payload file), an Ed25519 detached signature
//! and the immutable front-end assets.  The OCI image itself is *not* stored
//! in the ZIP: the manifest names it by `repository@sha256:<digest>`.
//!
//! Hash domains (kept deliberately separate):
//! - `bundleDigest`   = SHA-256 of the raw uploaded ZIP (computed by registry)
//! - `artifactDigest` = SHA-256 of the canonical payload-index JSON
//! - `imageRef` digest = OCI registry content digest
//!
//! The publisher signature covers `opsweave.plugin.v1\n{artifactDigest}\n`.

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use opsweave_contracts::{canonical_json, AssetEntry, AssetIndex, ManifestV11};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use thiserror::Error;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

pub const SIGNATURE_DOMAIN: &str = "opsweave.plugin.v1";
pub const MANIFEST_PATH: &str = "manifest.json";
pub const PAYLOAD_INDEX_PATH: &str = "payload-index.json";
pub const SIGNATURE_PATH: &str = "signatures/publisher.sig";

#[derive(Debug, Clone)]
pub struct BundleLimits {
    pub max_zip_bytes: usize,
    pub max_uncompressed_bytes: u64,
    pub max_entries: usize,
    pub max_entry_bytes: u64,
    pub max_manifest_bytes: u64,
    pub max_compression_ratio: u64,
}

impl Default for BundleLimits {
    fn default() -> Self {
        Self {
            max_zip_bytes: 64 * 1024 * 1024,
            max_uncompressed_bytes: 256 * 1024 * 1024,
            max_entries: 2000,
            max_entry_bytes: 64 * 1024 * 1024,
            max_manifest_bytes: 1024 * 1024,
            max_compression_ratio: 200,
        }
    }
}

#[derive(Debug, Error)]
pub enum BundleError {
    #[error("bundle exceeds size limits: {0}")]
    Limit(String),
    #[error("unsafe archive path: {0}")]
    UnsafePath(String),
    #[error("duplicate or case-colliding archive entry: {0}")]
    Duplicate(String),
    #[error("archive is malformed: {0}")]
    Zip(String),
    #[error("missing required file: {0}")]
    Missing(String),
    #[error("manifest is invalid: {0}")]
    Manifest(String),
    #[error("payload digest mismatch: manifest={manifest}, computed={computed}")]
    PayloadDigest { manifest: String, computed: String },
    #[error("payload index does not match bundle contents")]
    PayloadIndexMismatch,
    #[error("publisher signature is invalid")]
    BadSignature,
    #[error("publisher key is invalid: {0}")]
    BadKey(String),
    #[error("front-end asset validation failed: {0}")]
    Frontend(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone)]
pub struct VerifiedBundle {
    pub manifest: ManifestV11,
    pub files: BTreeMap<String, Vec<u8>>,
    pub bundle_digest: String,
    pub artifact_digest: String,
    pub payload_index: Vec<AssetEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PayloadIndexFile {
    version: String,
    files: Vec<AssetEntry>,
}

/// Read and validate a ZIP into memory while enforcing anti-zip-bomb rules.
/// The returned map excludes no files; callers decide what to persist.
pub fn read_zip(
    bytes: &[u8],
    limits: &BundleLimits,
) -> Result<BTreeMap<String, Vec<u8>>, BundleError> {
    if bytes.len() > limits.max_zip_bytes {
        return Err(BundleError::Limit(format!(
            "zip is {} bytes, limit is {}",
            bytes.len(),
            limits.max_zip_bytes
        )));
    }
    let reader = Cursor::new(bytes);
    let mut archive =
        ZipArchive::new(reader).map_err(|error| BundleError::Zip(error.to_string()))?;
    if archive.len() > limits.max_entries {
        return Err(BundleError::Limit(format!(
            "{} entries, limit {}",
            archive.len(),
            limits.max_entries
        )));
    }
    let mut files = BTreeMap::new();
    let mut seen = HashSet::new();
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| BundleError::Zip(error.to_string()))?;
        let name = entry.name().to_string();
        validate_archive_path(&name)?;
        if entry.is_dir() {
            continue;
        }
        if let Some(mode) = entry.unix_mode() {
            if mode & 0o170000 == 0o120000 {
                return Err(BundleError::UnsafePath(format!(
                    "symlink entry is not allowed: {name}"
                )));
            }
        }
        let size = entry.size();
        if size > limits.max_entry_bytes {
            return Err(BundleError::Limit(format!(
                "entry {name} is {size} bytes, limit {}",
                limits.max_entry_bytes
            )));
        }
        total = total.saturating_add(size);
        if total > limits.max_uncompressed_bytes {
            return Err(BundleError::Limit(format!(
                "uncompressed total exceeds {} bytes",
                limits.max_uncompressed_bytes
            )));
        }
        if size > 0 && entry.compressed_size() > 0 {
            let ratio = size / entry.compressed_size().max(1);
            if ratio > limits.max_compression_ratio {
                return Err(BundleError::Limit(format!(
                    "entry {name} compression ratio {ratio} exceeds {}",
                    limits.max_compression_ratio
                )));
            }
        }
        let key = name.to_ascii_lowercase();
        if !seen.insert(key) {
            return Err(BundleError::Duplicate(name));
        }
        let mut content = Vec::with_capacity(size.min(16 * 1024 * 1024) as usize);
        entry
            .read_to_end(&mut content)
            .map_err(|error| BundleError::Zip(error.to_string()))?;
        files.insert(name, content);
    }
    if files.len() > limits.max_entries {
        return Err(BundleError::Limit("too many files".into()));
    }
    Ok(files)
}

/// Verify a bundle against the trusted publisher key.
pub fn verify_bundle(
    bytes: &[u8],
    publisher_key: &VerifyingKey,
    limits: &BundleLimits,
) -> Result<VerifiedBundle, BundleError> {
    let files = read_zip(bytes, limits)?;
    let manifest_bytes = files
        .get(MANIFEST_PATH)
        .ok_or_else(|| BundleError::Missing(MANIFEST_PATH.into()))?;
    if manifest_bytes.len() as u64 > limits.max_manifest_bytes {
        return Err(BundleError::Limit("manifest.json is too large".into()));
    }
    let manifest: ManifestV11 = serde_json::from_slice(manifest_bytes)
        .map_err(|error| BundleError::Manifest(error.to_string()))?;
    manifest
        .validate()
        .map_err(|errors| BundleError::Manifest(errors.join("; ")))?;

    let payload_index_bytes = files
        .get(PAYLOAD_INDEX_PATH)
        .ok_or_else(|| BundleError::Missing(PAYLOAD_INDEX_PATH.into()))?;
    let payload_index: PayloadIndexFile = serde_json::from_slice(payload_index_bytes)
        .map_err(|error| BundleError::Manifest(format!("payload-index.json: {error}")))?;
    if payload_index.version != "1" {
        return Err(BundleError::Manifest(
            "payload-index version must be 1".into(),
        ));
    }
    let computed = compute_payload(&files)?;
    if computed != payload_index.files {
        return Err(BundleError::PayloadIndexMismatch);
    }
    let canonical = canonical_json(
        &serde_json::to_value(&computed)
            .map_err(|error| BundleError::Manifest(error.to_string()))?,
    );
    let artifact_digest = sha256_digest(&canonical);
    if artifact_digest != manifest.artifact_digest {
        return Err(BundleError::PayloadDigest {
            manifest: manifest.artifact_digest.clone(),
            computed: artifact_digest,
        });
    }

    let signature_hex = files
        .get(SIGNATURE_PATH)
        .ok_or_else(|| BundleError::Missing(SIGNATURE_PATH.into()))?;
    let signature_hex = std::str::from_utf8(signature_hex)
        .map_err(|_| BundleError::BadSignature)?
        .trim();
    let manifest_value = serde_json::to_value(&manifest)
        .map_err(|error| BundleError::Manifest(error.to_string()))?;
    let manifest_digest = sha256_digest(&canonical_json(&manifest_value));
    verify_artifact_signature(
        publisher_key,
        &artifact_digest,
        &manifest_digest,
        signature_hex,
    )?;

    if let Some(frontend) = &manifest.frontend {
        let index_bytes = files
            .get(&frontend.asset_index)
            .ok_or_else(|| BundleError::Missing(frontend.asset_index.clone()))?;
        if sha256_digest(index_bytes) != frontend.asset_index_digest {
            return Err(BundleError::Frontend(
                "asset-index digest does not match manifest".into(),
            ));
        }
        let index: AssetIndex = serde_json::from_slice(index_bytes)
            .map_err(|error| BundleError::Frontend(format!("asset index: {error}")))?;
        index
            .validate()
            .map_err(|errors| BundleError::Frontend(errors.join("; ")))?;
        for asset in &index.assets {
            let content = files
                .get(&asset.path)
                .ok_or_else(|| BundleError::Frontend(format!("missing asset {}", asset.path)))?;
            if content.len() as u64 != asset.size {
                return Err(BundleError::Frontend(format!(
                    "asset size mismatch: {}",
                    asset.path
                )));
            }
            if sha256_digest(content) != asset.sha256 {
                return Err(BundleError::Frontend(format!(
                    "asset digest mismatch: {}",
                    asset.path
                )));
            }
        }
        let remote = files
            .get(&frontend.remote_entry)
            .ok_or_else(|| BundleError::Missing(frontend.remote_entry.clone()))?;
        if sha256_digest(remote) != frontend.remote_entry_digest {
            return Err(BundleError::Frontend(
                "remoteEntry digest does not match manifest".into(),
            ));
        }
    }

    Ok(VerifiedBundle {
        manifest,
        files,
        bundle_digest: sha256_digest(bytes),
        artifact_digest,
        payload_index: computed,
    })
}

/// Produce canonical payload entries for every file except the manifest,
/// payload index and detached signatures.
pub fn compute_payload(files: &BTreeMap<String, Vec<u8>>) -> Result<Vec<AssetEntry>, BundleError> {
    let mut entries = Vec::new();
    for (path, content) in files {
        if path == MANIFEST_PATH || path == PAYLOAD_INDEX_PATH || path.starts_with("signatures/") {
            continue;
        }
        entries.push(AssetEntry {
            path: path.clone(),
            size: content.len() as u64,
            sha256: sha256_digest(content),
        });
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

/// Build a deterministic signed bundle from a directory.
///
/// The directory must contain `manifest.json`, `frontend/asset-index.json`
/// when a frontend is declared, and all referenced assets. The function
/// rewrites `artifactDigest`, `assetIndexDigest` and `remoteEntryDigest` in the
/// manifest so publishers cannot accidentally sign inconsistent digest fields.
pub fn build_bundle_from_dir(
    input_dir: &Path,
    signing_key: &SigningKey,
    limits: &BundleLimits,
) -> Result<Vec<u8>, BundleError> {
    let mut files = read_directory(input_dir)?;
    let manifest_bytes = files
        .remove(MANIFEST_PATH)
        .ok_or_else(|| BundleError::Missing(MANIFEST_PATH.into()))?;
    let mut manifest_value: serde_json::Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| BundleError::Manifest(error.to_string()))?;
    files.remove(PAYLOAD_INDEX_PATH);
    files.retain(|path, _| !path.starts_with("signatures/"));

    let entries = compute_payload(&files)?;
    let entries_value =
        serde_json::to_value(&entries).map_err(|error| BundleError::Manifest(error.to_string()))?;
    let canonical = canonical_json(&entries_value);
    let artifact_digest = sha256_digest(&canonical);
    let payload_index = canonical_json(
        &serde_json::to_value(PayloadIndexFile {
            version: "1".into(),
            files: entries.clone(),
        })
        .map_err(|error| BundleError::Manifest(error.to_string()))?,
    );

    let manifest_object = manifest_value
        .as_object_mut()
        .ok_or_else(|| BundleError::Manifest("manifest must be a JSON object".into()))?;
    manifest_object.insert(
        "artifactDigest".into(),
        serde_json::Value::String(artifact_digest.clone()),
    );
    if let Some(frontend) = manifest_object
        .get_mut("frontend")
        .and_then(|value| value.as_object_mut())
    {
        let index_path = frontend
            .get("assetIndex")
            .and_then(|value| value.as_str())
            .unwrap_or("frontend/asset-index.json")
            .to_string();
        let index_bytes = files
            .get(&index_path)
            .ok_or_else(|| BundleError::Missing(index_path.clone()))?;
        let remote_path = frontend
            .get("remoteEntry")
            .and_then(|value| value.as_str())
            .ok_or_else(|| BundleError::Manifest("frontend.remoteEntry missing".into()))?
            .to_string();
        let remote_bytes = files
            .get(&remote_path)
            .ok_or_else(|| BundleError::Missing(remote_path.clone()))?;
        frontend.insert(
            "assetIndexDigest".into(),
            serde_json::Value::String(sha256_digest(index_bytes)),
        );
        frontend.insert(
            "remoteEntryDigest".into(),
            serde_json::Value::String(sha256_digest(remote_bytes)),
        );
        // Recompute the index digests after any remoteEntry rewrite is impossible
        // by contract; the asset index must already describe exactly these bytes.
        let index: AssetIndex = serde_json::from_slice(index_bytes)
            .map_err(|error| BundleError::Frontend(error.to_string()))?;
        index
            .validate()
            .map_err(|errors| BundleError::Frontend(errors.join("; ")))?;
        for asset in &index.assets {
            let content = files
                .get(&asset.path)
                .ok_or_else(|| BundleError::Frontend(format!("missing asset {}", asset.path)))?;
            if sha256_digest(content) != asset.sha256 || content.len() as u64 != asset.size {
                return Err(BundleError::Frontend(format!(
                    "asset index is stale for {}",
                    asset.path
                )));
            }
        }
    }

    let manifest: ManifestV11 = serde_json::from_value(manifest_value.clone())
        .map_err(|error| BundleError::Manifest(error.to_string()))?;
    manifest
        .validate()
        .map_err(|errors| BundleError::Manifest(errors.join("; ")))?;
    let canonical_manifest_value = serde_json::to_value(&manifest)
        .map_err(|error| BundleError::Manifest(error.to_string()))?;
    let manifest_json = canonical_json(&canonical_manifest_value);
    let manifest_digest = sha256_digest(&manifest_json);
    let signature_hex = sign_artifact(signing_key, &artifact_digest, &manifest_digest);
    let signature_bytes = signature_hex.into_bytes();

    let mut all_files = files;
    all_files.insert(MANIFEST_PATH.into(), manifest_json);
    all_files.insert(PAYLOAD_INDEX_PATH.into(), payload_index);
    all_files.insert(SIGNATURE_PATH.into(), signature_bytes);

    let mut out = Vec::new();
    {
        let mut writer = ZipWriter::new(Cursor::new(&mut out));
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644)
            .last_modified_time(
                zip::DateTime::from_date_and_time(1980, 1, 1, 0, 0, 0)
                    .expect("valid fixed zip timestamp"),
            );
        for (path, content) in &all_files {
            writer
                .start_file(path, options)
                .map_err(|error| BundleError::Zip(error.to_string()))?;
            writer
                .write_all(content)
                .map_err(|error| BundleError::Zip(error.to_string()))?;
        }
        writer
            .finish()
            .map_err(|error| BundleError::Zip(error.to_string()))?;
    }
    if out.len() > limits.max_zip_bytes {
        return Err(BundleError::Limit("built bundle is too large".into()));
    }
    Ok(out)
}

fn read_directory(root: &Path) -> Result<BTreeMap<String, Vec<u8>>, BundleError> {
    let mut files = BTreeMap::new();
    for entry in walkdir::WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|error| BundleError::Io(std::io::Error::other(error)))?;
        if !entry.file_type().is_file() {
            if entry.file_type().is_symlink() {
                return Err(BundleError::UnsafePath(format!(
                    "symlink not allowed: {}",
                    entry.path().display()
                )));
            }
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|_| BundleError::UnsafePath("path outside input".into()))?;
        let name = relative
            .components()
            .map(|component| match component {
                Component::Normal(value) => value.to_string_lossy().into_owned(),
                _ => String::new(),
            })
            .collect::<Vec<_>>()
            .join("/");
        validate_archive_path(&name)?;
        let content = fs::read(entry.path())?;
        files.insert(name, content);
    }
    Ok(files)
}

fn validate_archive_path(name: &str) -> Result<(), BundleError> {
    if name.is_empty() || name.starts_with('/') || name.contains('\\') || name.contains('\0') {
        return Err(BundleError::UnsafePath(name.into()));
    }
    let path = PathBuf::from(name);
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                if value == "." || value == ".." {
                    return Err(BundleError::UnsafePath(name.into()));
                }
            }
            _ => return Err(BundleError::UnsafePath(name.into())),
        }
    }
    let allowed = name == MANIFEST_PATH
        || name == PAYLOAD_INDEX_PATH
        || name == SIGNATURE_PATH
        || name.starts_with("frontend/");
    if !allowed {
        return Err(BundleError::UnsafePath(format!(
            "unsupported bundle path: {name}"
        )));
    }
    Ok(())
}

pub fn sha256_digest(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

pub fn sign_artifact(
    signing_key: &SigningKey,
    artifact_digest: &str,
    manifest_digest: &str,
) -> String {
    let message = signature_message(artifact_digest, manifest_digest);
    hex::encode(signing_key.sign(message.as_bytes()).to_bytes())
}

pub fn verify_artifact_signature(
    publisher_key: &VerifyingKey,
    artifact_digest: &str,
    manifest_digest: &str,
    signature_hex: &str,
) -> Result<(), BundleError> {
    let signature_bytes = hex::decode(signature_hex).map_err(|_| BundleError::BadSignature)?;
    if signature_bytes.len() != 64 {
        return Err(BundleError::BadSignature);
    }
    let signature =
        Signature::from_slice(&signature_bytes).map_err(|_| BundleError::BadSignature)?;
    let message = signature_message(artifact_digest, manifest_digest);
    publisher_key
        .verify(message.as_bytes(), &signature)
        .map_err(|_| BundleError::BadSignature)
}

fn signature_message(artifact_digest: &str, manifest_digest: &str) -> String {
    format!("{SIGNATURE_DOMAIN}\n{artifact_digest}\n{manifest_digest}\n")
}

pub fn public_key_hex(key: &VerifyingKey) -> String {
    hex::encode(key.to_bytes())
}

pub fn parse_public_key(value: &str) -> Result<VerifyingKey, BundleError> {
    let bytes = hex::decode(value.trim()).map_err(|_| BundleError::BadKey("not hex".into()))?;
    if bytes.len() != 32 {
        return Err(BundleError::BadKey("expected 32-byte Ed25519 key".into()));
    }
    VerifyingKey::from_bytes(
        bytes
            .as_slice()
            .try_into()
            .map_err(|_| BundleError::BadKey("expected 32 bytes".into()))?,
    )
    .map_err(|error| BundleError::BadKey(error.to_string()))
}

pub fn key_fingerprint(key: &VerifyingKey) -> String {
    sha256_digest(&key.to_bytes())
}

pub fn generate_signing_key() -> SigningKey {
    let mut csprng = rand::rngs::OsRng;
    SigningKey::generate(&mut csprng)
}

/// Read a private key file containing either a 32-byte hex seed or a 64-byte
/// hex keypair (the seed is the first 32 bytes).
pub fn read_signing_key(path: &Path) -> Result<SigningKey, BundleError> {
    let value = fs::read_to_string(path)?;
    let bytes = hex::decode(value.trim()).map_err(|_| BundleError::BadKey("not hex".into()))?;
    if bytes.len() != 32 && bytes.len() != 64 {
        return Err(BundleError::BadKey(
            "private key must be a 32-byte seed or 64-byte keypair in hex".into(),
        ));
    }
    let seed: [u8; 32] = bytes[..32]
        .try_into()
        .map_err(|_| BundleError::BadKey("bad seed".into()))?;
    Ok(SigningKey::from_bytes(&seed))
}

/// Extract a verified bundle into an immutable version directory. Refuses to
/// overwrite an existing directory.
pub fn extract_verified(bundle: &VerifiedBundle, destination: &Path) -> Result<(), BundleError> {
    if destination.exists() {
        return Err(BundleError::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("destination already exists: {}", destination.display()),
        )));
    }
    fs::create_dir_all(destination)?;
    for (relative, content) in &bundle.files {
        let path = destination.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, content)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    fn template(assets: bool) -> serde_json::Value {
        serde_json::json!({
            "schemaVersion": "1.1",
            "id": "dev.opsweave.test",
            "version": "0.0.1",
            "publisher": "trusted-team",
            "compatibility": {"kernelApiMajor": 1, "webSdkMajor": 1},
            "artifactDigest": format!("sha256:{}", "0".repeat(64)),
            "frontend": if assets { serde_json::json!({
                "remoteEntry": "frontend/remoteEntry.js",
                "remoteEntryDigest": format!("sha256:{}", "0".repeat(64)),
                "assetIndex": "frontend/asset-index.json",
                "assetIndexDigest": format!("sha256:{}", "0".repeat(64)),
                "contributions": []
            })} else { serde_json::Value::Null },
            "backend": {
                "runtime": "oci",
                "imageRef": format!("localhost:5000/opsweave/test@sha256:{}", "a".repeat(64)),
                "protocol": {"name": "http-json", "version": "1", "containerPort": 8080},
                "health": {"readinessPath": "/_opsweave/health/ready", "livenessPath": "/_opsweave/health/live"},
                "apiPrefix": "/api/test"
            },
            "provides": [],
            "requires": [],
            "permissions": [],
            "resources": {"cpuMillis": 100, "memoryMiB": 64}
        })
    }

    fn write_fixture(dir: &Path, assets: bool) {
        let mut manifest = template(assets);
        fs::write(
            dir.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        if assets {
            fs::create_dir_all(dir.join("frontend/assets")).unwrap();
            let remote = b"window.TestPlugin={register(){return {routes:[]}}};";
            fs::write(dir.join("frontend/remoteEntry.js"), remote).unwrap();
            let chunk = b"console.log('chunk');";
            fs::write(dir.join("frontend/assets/chunk.js"), chunk).unwrap();
            let index = serde_json::json!({
                "version": "1",
                "assets": [
                    {"path":"frontend/remoteEntry.js","size":remote.len(),"sha256":sha256_digest(remote)},
                    {"path":"frontend/assets/chunk.js","size":chunk.len(),"sha256":sha256_digest(chunk)}
                ]
            });
            fs::write(
                dir.join("frontend/asset-index.json"),
                serde_json::to_vec_pretty(&index).unwrap(),
            )
            .unwrap();
        }
        manifest["frontend"] = manifest["frontend"].clone();
        fs::write(
            dir.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn builds_and_verifies_bundle() {
        let dir = tempdir().unwrap();
        write_fixture(dir.path(), true);
        let key = generate_signing_key();
        let bundle = build_bundle_from_dir(dir.path(), &key, &BundleLimits::default()).unwrap();
        let verified =
            verify_bundle(&bundle, &key.verifying_key(), &BundleLimits::default()).unwrap();
        assert_eq!(verified.manifest.id, "dev.opsweave.test");
        assert_eq!(
            verified.manifest.frontend.unwrap().remote_entry,
            "frontend/remoteEntry.js"
        );
        assert!(verified.artifact_digest.starts_with("sha256:"));
        assert_ne!(verified.bundle_digest, verified.artifact_digest);
    }

    #[test]
    fn rejects_tampered_payload() {
        let dir = tempdir().unwrap();
        write_fixture(dir.path(), false);
        let key = generate_signing_key();
        let bundle = build_bundle_from_dir(dir.path(), &key, &BundleLimits::default()).unwrap();
        let mut files = read_zip(&bundle, &BundleLimits::default()).unwrap();
        files.insert("frontend/remoteEntry.js".into(), b"tampered".to_vec());
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (path, content) in files {
            writer
                .start_file(path, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(&content).unwrap();
        }
        let tampered = writer.finish().unwrap().into_inner();
        assert!(verify_bundle(&tampered, &key.verifying_key(), &BundleLimits::default()).is_err());
    }

    #[test]
    fn manifest_image_reference_is_covered_by_signature() {
        let dir = tempdir().unwrap();
        write_fixture(dir.path(), false);
        let key = generate_signing_key();
        let bundle = build_bundle_from_dir(dir.path(), &key, &BundleLimits::default()).unwrap();
        let mut files = read_zip(&bundle, &BundleLimits::default()).unwrap();
        let mut manifest: serde_json::Value =
            serde_json::from_slice(files.get(MANIFEST_PATH).unwrap()).unwrap();
        manifest["backend"]["imageRef"] = serde_json::Value::String(format!(
            "localhost:5000/opsweave/test@sha256:{}",
            "b".repeat(64)
        ));
        files.insert(MANIFEST_PATH.into(), serde_json::to_vec(&manifest).unwrap());
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (path, content) in files {
            writer
                .start_file(path, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(&content).unwrap();
        }
        let tampered = writer.finish().unwrap().into_inner();
        assert!(matches!(
            verify_bundle(&tampered, &key.verifying_key(), &BundleLimits::default()),
            Err(BundleError::BadSignature)
        ));
    }

    #[test]
    fn rejects_path_traversal() {
        let mut out = Vec::new();
        {
            let mut writer = ZipWriter::new(Cursor::new(&mut out));
            writer
                .start_file("../escape.txt", SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"x").unwrap();
            writer.finish().unwrap();
        }
        assert!(read_zip(&out, &BundleLimits::default()).is_err());
    }
}
