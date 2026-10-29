import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n';

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

/** Wire-level readiness codes from `/readyz`. These are protocol values, not display copy. */
type ReadinessCode = 'READY' | 'NOT_READY' | 'UNKNOWN';

/** Only the rendered label is localized; the code above stays stable on the wire. */
const READINESS_LABEL_KEYS: Record<ReadinessCode, MessageKey> = {
  READY: 'badge.value.ready',
  NOT_READY: 'badge.value.notReady',
  UNKNOWN: 'badge.value.unknown',
};

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
  const { t, formatDateTime } = useI18n();
  const [identity, setIdentity] = useState<BuildIdentity | null>(null);
  const [status, setStatus] = useState<ReadinessCode>('UNKNOWN');

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
        if (!cancelled) setStatus('UNKNOWN');
      }
    }

    void load();
    return () => { cancelled = true; };
  }, []);

  // Compared before localization: the environment value is kernel data, never copy.
  // Guard kept for the day the wire contract grows a PRODUCTION member; today the
  // kernel can only answer STAGING, DEVELOPMENT or UNKNOWN.
  if (identity?.environment === 'PRODUCTION') return null;

  const unknown = t('badge.value.unknown');
  const environment = identity?.environment || unknown;
  const commit = identity?.commitSha ? identity.commitSha.slice(0, 7) : unknown;
  const deployedSource = identity?.buildTime || identity?.startedAt;
  const deployedAt = deployedSource ? formatDateTime(deployedSource) : unknown;

  return (
    <footer
      className="toolbar version-badge"
      /* Frozen: tests/ui/staging-smoke.spec.ts locates the badge by this accessible name. */
      aria-label="Deployment version"
      style={{ padding: '10px 28px 18px', borderTop: '1px solid var(--ow-border)' }}
    >
      <Chip field="environment" label={t('badge.environment')} value={environment} />
      <Chip field="commit" label={t('badge.commit')} value={commit} title={identity?.commitSha ?? undefined} />
      <Chip field="deployedAt" label={t('badge.deployedAt')} value={deployedAt} />
      <Chip field="status" label={t('badge.status')} value={t(READINESS_LABEL_KEYS[status])} />
    </footer>
  );
}
