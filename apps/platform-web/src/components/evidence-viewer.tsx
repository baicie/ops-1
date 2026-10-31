import * as React from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import type { IncidentEvidence } from '../types';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Icon } from './Icons';
import { badgeVariantForTone } from './status-tone';
import { CopyButton } from './Ui';
import {
  classifyFailure,
  contentFailurePhase,
  contentPanelMode,
  contentPhaseKeys,
  digestVerdict,
  digestVerdictKey,
  digestVerdictTone,
  evidenceContentStatusKey,
  evidenceContentStatusTone,
  evidenceExportFileName,
  evidenceKindKey,
  sha256Hex,
  type ContentReadPhase,
  type DigestVerdict,
} from '../incidents';

/**
 * The evidence content viewer (G12 B2).
 *
 * One rule decides everything this component may do with the bytes: content is untrusted text.
 * It is a log excerpt pasted by an operator, a JSON document a source produced, or an HTML
 * fragment someone copied out of a dashboard - and none of those distinctions are made here.
 * There is no HTML-injection escape hatch (the React prop whose name begins with "dangerously"),
 * no markdown renderer, no syntax highlighter and no iframe: the text goes into a React text
 * child, which is a text node, and a browser does not execute a text node. The browser spec
 * submits script and img-onerror payloads and asserts both that they are visible verbatim and
 * that nothing executed.
 *
 * The second rule is that the digest is not taken on faith. The kernel sends sha256 over the
 * bytes it stored; this component recomputes sha256 over the text it is about to display and
 * compares. A mismatch is rendered as a refusal, and a runtime without WebCrypto says "not
 * independently checked" rather than pretending it verified anything.
 */

interface ContentRead {
  phase: ContentReadPhase;
  text: string | null;
  /** The digest the kernel recomputed and sent as X-Evidence-Digest. */
  digest: string | null;
  contentType: string | null;
  bytes: number | null;
  verdict: DigestVerdict;
  failure: unknown;
  observedAt: string | null;
}

const EMPTY_READ: ContentRead = {
  phase: 'loading',
  text: null,
  digest: null,
  contentType: null,
  bytes: null,
  verdict: 'unknown',
  failure: null,
  observedAt: null,
};

export function EvidenceContentViewer({
  incidentId,
  row,
  onClose,
}: {
  incidentId: string;
  row: IncidentEvidence;
  onClose: () => void;
}) {
  const t = useT();
  const mode = contentPanelMode(row.contentStatus);
  const [read, setRead] = React.useState<ContentRead>(EMPTY_READ);
  const [reload, setReload] = React.useState(0);

  React.useEffect(() => {
    if (mode === 'legacy') {
      // Nothing to fetch: the kernel holds a locator, not bytes. Saying "legacy" here is the
      // whole answer, and issuing a request that is known to 404 would dress it up as a failure.
      setRead({ ...EMPTY_READ, phase: 'unavailable', observedAt: null });
      return;
    }
    let cancelled = false;
    setRead({ ...EMPTY_READ, phase: 'loading' });
    const path =
      '/api/v1/incidents/' + encodeURIComponent(incidentId) +
      '/evidence/' + encodeURIComponent(row.id) + '/content';
    api
      .text(path)
      .then(async (result) => {
        // Recomputed over the text that will be rendered, not over anything a caller supplied.
        const computed = await sha256Hex(result.text);
        if (cancelled) return;
        setRead({
          phase: 'ready',
          text: result.text,
          digest: result.digest,
          contentType: result.contentType ?? row.contentType,
          bytes: result.bytes,
          verdict: digestVerdict(computed, result.digest),
          failure: null,
          observedAt: new Date().toISOString(),
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setRead({ ...EMPTY_READ, phase: contentFailurePhase(cause) ?? 'failed', failure: cause });
      });
    return () => {
      cancelled = true;
    };
  }, [incidentId, row.id, row.contentType, mode, reload]);

  const exportContent = React.useCallback(() => {
    if (read.text === null) return;
    // The export is the bytes already on screen saved by the browser. There is no export
    // endpoint, so a downloaded file cannot contain anything this read did not return.
    const type = (read.contentType ?? '') === 'application/json' ? 'application/json' : 'text/plain';
    const url = URL.createObjectURL(new Blob([read.text], { type: type + ';charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = evidenceExportFileName({ id: row.id, contentType: read.contentType });
    anchor.rel = 'noopener';
    anchor.click();
    URL.revokeObjectURL(url);
  }, [read.text, read.contentType, row.id]);

  const phaseKeys = contentPhaseKeys(read.phase);
  const failure = classifyFailure(read.failure);

  return (
    <div
      className="panel"
      data-testid="evidence-content-panel"
      data-content-state={read.phase}
      data-content-mode={mode}
      data-evidence-id={row.id}
      data-content-type={read.contentType ?? ''}
      data-digest-verdict={read.phase === 'ready' ? read.verdict : ''}
    >
      <div className="panel-head">
        <div>
          <h2>{t('incidents.content.title')}</h2>
          <p>{t('incidents.content.description')}</p>
        </div>
        <div className="job-subtitle">
          <Badge
            variant={badgeVariantForTone(evidenceContentStatusTone(row.contentStatus))}
            data-testid="evidence-content-status"
            data-content-status={row.contentStatus}
          >
            {t(evidenceContentStatusKey(row.contentStatus))}
          </Badge>
          <Button variant="secondary" data-testid="evidence-content-refresh" onClick={() => setReload((value) => value + 1)} disabled={mode === 'legacy'}>
            <Icon name="refresh" size={15} /> {t('action.refresh')}
          </Button>
          <Button variant="secondary" data-testid="evidence-content-close" onClick={onClose}>
            {t('incidents.content.action.close')}
          </Button>
        </div>
      </div>

      <div className="pad">
        <div className="kv-grid">
          <div className="kv"><span className="kv-label">{t('table.kind')}</span><span className="kv-value">{t(evidenceKindKey(row.kind))}</span></div>
          <div className="kv"><span className="kv-label">{t('table.source')}</span><span className="kv-value mono" data-testid="evidence-content-source">{row.source}</span></div>
          {/* Two clocks, named: collectedAt is what the submitter claims, capturedAt is when the
              kernel accepted the bytes. They are never merged into one "time". */}
          <div className="kv"><span className="kv-label">{t('incidents.content.collectedAt')}</span><span className="kv-value mono" data-testid="evidence-content-collected-at">{row.collectedAt}</span></div>
          <div className="kv"><span className="kv-label">{t('incidents.content.capturedAt')}</span><span className="kv-value mono" data-testid="evidence-content-captured-at">{row.contentCapturedAt ?? t('common.none')}</span></div>
          <div className="kv"><span className="kv-label">{t('incidents.content.type')}</span><span className="kv-value mono">{read.contentType ?? row.contentType ?? t('common.none')}</span></div>
          <div className="kv"><span className="kv-label">{t('incidents.content.bytes')}</span><span className="kv-value mono" data-testid="evidence-content-bytes">{read.bytes ?? row.contentBytes ?? t('common.none')}</span></div>
          <div className="kv"><span className="kv-label">{t('incidents.content.retentionExpiresAt')}</span><span className="kv-value mono">{row.contentRetentionExpiresAt ?? t('common.none')}</span></div>
        </div>

        {/* The integrity summary: the kernel's digest, and whether this browser reproduced it. */}
        <p className="muted small" data-testid="evidence-content-digest" data-server-digest={read.digest ?? row.contentSha256 ?? ''}>
          {t('incidents.content.digest.label')} <code>{read.digest ?? row.contentSha256 ?? t('common.none')}</code>
        </p>
        {read.phase === 'ready' ? (
          <p>
            <Badge variant={badgeVariantForTone(digestVerdictTone(read.verdict))} data-testid="evidence-digest-verdict" data-digest-verdict={read.verdict}>
              {t(digestVerdictKey(read.verdict))}
            </Badge>
          </p>
        ) : null}

        {read.phase === 'loading' ? (
          <p className="muted small" aria-busy="true" data-testid="evidence-content-loading">{t('incidents.content.phase.loading')}</p>
        ) : null}

        {phaseKeys ? (
          <div data-testid="evidence-content-notice" data-content-state={read.phase}>
            <p><strong>{t(phaseKeys.title)}</strong></p>
            <p className="muted small">{t(phaseKeys.description)}</p>
            {failure.code ? (
              <p className="muted small">
                <code data-testid="evidence-content-code">{failure.code}</code>
                {failure.status !== null ? <span data-testid="evidence-content-status-code">{' ' + failure.status}</span> : null}
              </p>
            ) : null}
          </div>
        ) : null}

        {read.phase === 'ready' && read.text !== null ? (
          <>
            <div className="job-subtitle">
              <CopyButton value={read.text} label={t('incidents.content.action.copy')} testId="evidence-content-copy" />
              <Button variant="secondary" data-testid="evidence-content-export" onClick={exportContent}>
                {t('incidents.content.action.export')}
              </Button>
            </div>
            <p className="muted small" data-testid="evidence-content-untrusted">{t('incidents.content.untrustedNote')}</p>
            {/* The only place content is rendered, and it is a text node. Do not replace this
                with markup: every XSS case in this slice arrives through this element. */}
            <pre className="evidence-content" data-testid="evidence-content-text">{read.text}</pre>
          </>
        ) : null}
      </div>
    </div>
  );
}
