import React, { useEffect, useState } from 'react';
import { Icon } from './Icons';
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

/**
 * Non-production deployment badge: which build is the browser actually looking at?
 *
 * The probe is deliberately a bare fetch instead of the shared api client, so a
 * failing version endpoint can never trigger the global 401/unauthorized path
 * or throw into the shell.
 *
 * V4: this used to be a permanent four-row table in the rail - environment, commit,
 * deployed-at and status, each 11px, with five hairlines inside a 240px column. An
 * administrator checks it occasionally; nobody reads it while working. It is now one line
 * (readiness dot, environment, commit) and the exact deploy time opens on request, so the
 * rail gives that space back to navigation without losing the fact.
 */
export function VersionBadge() {
  const { t, formatDateTime } = useI18n();
  const [identity, setIdentity] = useState<BuildIdentity | null>(null);
  const [status, setStatus] = useState<ReadinessCode>('UNKNOWN');
  const [open, setOpen] = useState(false);

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
    <footer className="sidebar-meta-block" aria-label="Deployment version">
      <button
        type="button"
        className="sidebar-meta"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
        data-testid="version-badge-toggle"
      >
        <span className="sidebar-meta-dot" data-state={status} aria-hidden="true" />
        <span data-version-field="environment"><strong className="sidebar-meta-env">{environment}</strong></span>
        <span aria-hidden="true">·</span>
        <span data-version-field="commit" title={identity?.commitSha ?? undefined}><strong className="sidebar-meta-sha">{commit}</strong></span>
        <Icon name="down" size={12} className="sidebar-meta-chevron" />
      </button>
      {open ? (
        <dl className="sidebar-meta-details">
          <div className="sidebar-meta-row">
            <dt>{t('badge.status')}</dt>
            <dd data-version-field="status"><strong>{t(READINESS_LABEL_KEYS[status])}</strong></dd>
          </div>
          <div className="sidebar-meta-row">
            <dt>{t('badge.deployedAt')}</dt>
            <dd data-version-field="deployedAt"><strong>{deployedAt}</strong></dd>
          </div>
        </dl>
      ) : null}
    </footer>
  );
}
