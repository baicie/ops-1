import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { Icon } from './Icons';
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
  // Rail state. At 64px the four labelled rows measured value widths of 0/0/1/0px: the rail
  // was printing four labels and no values. The rows are not deleted, they are the panel this
  // control opens - reachable by hover, by focus and by Enter, and its accessible name carries
  // all four values even before it is opened.
  const [railOpen, setRailOpen] = useState(false);
  const statusWord = t(VERDICT_COPY[verdict].short);
  const dotState = verdictDotState(verdict);

  useEffect(() => {
    if (!railOpen) return undefined;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setRailOpen(false); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [railOpen]);

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
  // One sentence for two readers: the control's accessible name and its tooltip. A mouse that
  // never opens the panel still reads all four facts by hovering the trigger.
  const railLabel = t('badge.railLabel', { environment, commit, deployedAt, status: statusWord });

  return (
    <footer className="sidebar-meta-block" aria-label="Deployment version">
      {/* Wide: no control, the labelled rows are the block. Rail: this 40px control and the
          rows become its panel (see the rail rule in styles.css §11). */}
      <button
        type="button"
        className="sidebar-meta-rail"
        data-testid="version-rail-trigger"
        aria-expanded={railOpen}
        aria-controls="sidebar-meta-panel"
        aria-label={railLabel}
        title={railLabel}
        onClick={() => setRailOpen((open) => !open)}
        // A pinned panel closes when focus leaves it: hover and focus reveal it transiently, the
        // click pins it, and Escape is the keyboard exit. Nothing floats over the canvas forever.
        onBlur={(event) => { if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) setRailOpen(false); }}
      >
        <span className="sidebar-meta-dot" data-state={dotState} aria-hidden="true" />
        <Icon name="chevron" size={12} className={railOpen ? 'sidebar-meta-chevron is-open' : 'sidebar-meta-chevron'} />
      </button>
      <div className="sidebar-meta-rows" id="sidebar-meta-panel" data-open={railOpen ? 'true' : 'false'}>
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