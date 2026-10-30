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

/**
 * Non-production deployment badge: which build is the browser actually looking at?
 *
 * The probe is deliberately a bare fetch instead of the shared api client, so a
 * failing version endpoint can never trigger the global 401/unauthorized path
 * or throw into the shell.
 *
 * V5 reversed one V4 decision. V4 collapsed four labelled rows into `● STAGING · bdb93b0`,
 * which saved 40px of rail and destroyed the readable anchor of the served-SHA self-proof:
 * a reader could no longer tell that `bdb93b0` was a commit, and the two staging smoke
 * checks that certify a deployment started failing on copy alone. The fields are labelled
 * again on three 16px rows instead of five - compact, quiet, legible without a click. The
 * interpunct separator is gone, so nothing can hang at the end of a wrapped line.
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
    <footer className="sidebar-meta-block" aria-label="Deployment version">
      <div className="sidebar-meta-rows">
        {/* Row 1 and row 3 own the full 240px rail; only the two short pairs share row 2.
            At two pairs per row on every line, "Environment STAGING" overflowed by 1px and
            rendered "STAGI..." - a truncated value is not a self-proof. */}
        <div className="sidebar-meta-row">
          <span className="sidebar-meta-field" data-version-field="environment">
            <span className="sidebar-meta-key">{t('badge.environment')}</span>
            <strong className="sidebar-meta-env">{environment}</strong>
          </span>
        </div>
        <div className="sidebar-meta-row">
          <span className="sidebar-meta-field" data-version-field="commit">
            <span className="sidebar-meta-key">{t('badge.commit')}</span>
            <strong className="sidebar-meta-sha" title={identity?.commitSha ?? undefined}>{commit}</strong>
          </span>
          <span className="sidebar-meta-field" data-version-field="status">
            <span className="sidebar-meta-key">{t('badge.status')}</span>
            <strong className="sidebar-meta-readiness">
              <span className="sidebar-meta-dot" data-state={status} aria-hidden="true" />
              {t(READINESS_LABEL_KEYS[status])}
            </strong>
          </span>
        </div>
        <div className="sidebar-meta-row">
          <span className="sidebar-meta-field" data-version-field="deployedAt">
            <span className="sidebar-meta-key">{t('badge.deployedAt')}</span>
            <strong className="sidebar-meta-time">{deployedAt}</strong>
          </span>
        </div>
      </div>
    </footer>
  );
}
