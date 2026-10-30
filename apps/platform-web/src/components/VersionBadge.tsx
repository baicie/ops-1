import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { VERDICT_COPY, usePlatformVerdict, verdictDotState } from '../lib/platform-status';

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
  // V5 printed the /readyz HTTP status as "Status READY", so the rail advertised READY on the
  // 403, error and not-configured pages whose body said otherwise. The field now carries the
  // shell's one verdict (lib/platform-status), the same value the topbar pill prints.
  const verdict = usePlatformVerdict();
  const statusWord = t(VERDICT_COPY[verdict].short);
  const dotState = verdictDotState(verdict);

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
        {/* One labelled fact per row. Two facts shared a row until the status field stopped
            being a short wire code: "Not configured" squeezed "Commit bfe8d70" from 46px of
            text into 42px of box, and a truncated SHA is not a self-proof. */}
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
        </div>
        <div className="sidebar-meta-row">
          <span className="sidebar-meta-field" data-version-field="status">
            <span className="sidebar-meta-key">{t('badge.status')}</span>
            <strong className="sidebar-meta-readiness" data-verdict={verdict}>
              <span className="sidebar-meta-dot" data-state={dotState} aria-hidden="true" />
              {statusWord}
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
