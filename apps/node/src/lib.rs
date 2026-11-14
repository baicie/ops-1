//! Library surface for the OpsWeave Node Runtime.
//!
//! The product is the `opsweave-node` binary; this target exists so the
//! integration tests under `tests/` can drive the real `DockerAdapter` against a
//! real daemon instead of re-implementing its decisions in a script. Only the
//! pieces those tests need are exported.
pub mod config;
pub mod docker;
pub mod logs;
pub mod runtime;
pub mod state_lock;
