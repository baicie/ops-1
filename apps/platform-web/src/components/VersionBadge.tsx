import React, { useEffect, useState } from 'react';

/**
 * Build identity reported by the Kernel at `GET /api/v1/version`.
 * Every field is optional on purpose: an older kernel, a proxy error page or a
 * missing value must degrade to UNKNOWN instead of inventing a build.
 */
type BuildIdentity = {
  version?: string | null;
  commitSha?: string | null;
  buildTime?: string | null;
  environment?: string | null;
  startedAt?: string | null;
};

const UNKNOWN = 'UNKNOWN';

function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : UNKNOWN;
}

function deployedAt(info: BuildIdentity | null): string {
  const value = info?.buildTime || info?.startedAt;
  if (!value) return UNKNOWN;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${parsed.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function Chip({ field, label, value, title }: { field: string; label: string; value: string; title?: string }) {
  return (
    <span className="meta-chip" data-version-field={field}>
      <span className="muted small">{label}</span>
      <strong className="mono" title={title}>{value}</strong>
    </span>
  );
}

/**
 * Non-production deployment badge: which build is the browser actually looking at?
 *
 * The probe is deliberately a bare fetch instead of the shared api client, so a
 * failing version endpoint can never trigger the global 401/unauthorized path
 * or throw into the shell.
 */
export function VersionBadge() {
  const [identity, setIdentity] = useState<BuildIdentity | null>(null);
  const [status, setStatus] = useState<string>(UNKNOWN);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch('/api/v1/version', {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        });
        if (!cancelled && response.ok) setIdentity((await response.json()) as BuildIdentity);
      } catch {
        // Best-effort: an unreachable kernel keeps every field at UNKNOWN.
      }
      try {
        const ready = await fetch('/readyz', {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        });
        if (!cancelled) setStatus(ready.ok ? 'READY' : 'NOT_READY');
      } catch {
        if (!cancelled) setStatus(UNKNOWN);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, []);

  const environment = identity?.environment || UNKNOWN;
  // Guard kept for the day the wire contract grows a PRODUCTION member; today the
  // kernel can only answer STAGING, DEVELOPMENT or UNKNOWN.
  if (environment === 'PRODUCTION') return null;

  return (
    <footer
      className="toolbar version-badge"
      aria-label="Deployment version"
      style={{ padding: '10px 28px 18px', borderTop: '1px solid var(--ow-border)' }}
    >
      <Chip field="environment" label="Environment" value={environment} />
      <Chip field="commit" label="Commit" value={shortSha(identity?.commitSha)} title={identity?.commitSha ?? undefined} />
      <Chip field="deployedAt" label="Deployed At" value={deployedAt(identity)} />
      <Chip field="status" label="Status" value={status} />
    </footer>
  );
}
