# ADR-010 — Docker CLI OCI adapter

- **Status:** accepted for the 0.0.1 reference implementation
- **Date:** 2026-10-22
- **Context:** The Node Runtime must manage OCI containers without giving plugins or web users access to the Docker socket. A linked Engine client (bollard) and a controlled CLI adapter are both viable; the adapter must be replaceable.
- **Decision:** Use a Node-owned adapter that invokes the Docker CLI with a fixed argument vector. Every deployment argument comes from the validated signed manifest or Kernel policy; image references must be pinned by `@sha256`. The adapter adds read-only rootfs, cap-drop ALL, no-new-privileges, CPU/memory/PID limits, no host mounts and loopback-only port publication.
- **Consequences:** The adapter is easy to audit and test locally, but the Node service account controls the Engine socket and must be hardened. A future Podman/containerd/Kubernetes adapter requires a new ADR and E2E evidence. Image signature/attestation is separate and not implemented.
