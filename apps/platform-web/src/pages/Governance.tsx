import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { usePolling } from '../hooks';
import type { NodeView } from '../types';
import { Icon } from '../components/Icons';
import { Button } from '../components/ui/button';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { EmptyState } from '../components/Ui';
import { AsyncBoundary } from '../components/app/async-boundary';
import { PageHeader } from '../components/app/page-header';
import { NoData, StatusIndicator, UnknownValue, indicatorStateForCode } from '../components/app/status-indicator';
import { useI18n, useT } from '../i18n';
import { formatDate } from '../format';
import { IdentityCell, StackCell, StatusPill, cardCellClass, formatIdentity, rankCardFacts, stackBody, stackHead, stackRow, stackTable } from './table-kit';

type Dataset = { datasetId: string; name: string; schemaRevision: number; updatedAt: string };
type QualityRun = { runId: string; datasetId: string; status: string; recordsExamined: number; recordsFailed: number; completedAt: string | null; createdAt: string };
type DatasetQuality = Dataset & { latest: QualityRun | null; runs: QualityRun[]; lineageCount: number };
type Summary = {
  datasetCount: number; datasetsWithQualityRuns: number;
  latestQuality: { passed: number; failed: number; error: number; pending: number; unknown: number };
  lineageWindowCount: number; lineageWindow: string;
  recentFailures: { runId: string; datasetId: string; datasetName: string; status: string; createdAt: string; completedAt: string | null; errorCode: string | null }[];
};

export function GovernancePage() {
  const t = useT();
  const { locale } = useI18n();
  const { data: nodes, error: nodeError, loading: nodeLoading, reload: reloadNodes } = usePolling(() => api.get<NodeView[]>('/api/v1/nodes'), 10000);
  const [datasets, setDatasets] = useState<DatasetQuality[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const [catalog, governance] = await Promise.all([
        api.gatewayGet<{ items: Dataset[] }>('opsweave.data-catalog', '/api/data-catalog/datasets'),
        api.gatewayGet<Summary>('opsweave.data-catalog', '/api/data-catalog/governance-summary'),
      ]);
      setSummary(governance);
      const enriched = await Promise.all((catalog.items || []).slice(0, 50).map(async (dataset) => {
        const [runs, lineage] = await Promise.all([
          api.gatewayGet<{ items: QualityRun[] }>('opsweave.data-catalog', `/api/data-catalog/datasets/${dataset.datasetId}/quality-runs?limit=20`),
          api.gatewayGet<{ items: unknown[] }>('opsweave.data-catalog', `/api/data-catalog/datasets/${dataset.datasetId}/lineage?limit=200`),
        ]);
        const items = runs.items || [];
        return { ...dataset, latest: items[0] || null, runs: items, lineageCount: (lineage.items || []).length };
      }));
      setDatasets(enriched);
    } catch (cause: any) { setError(cause); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  const nodeList = nodes || [];
  const ready = nodeList.filter((node) => node.status === 'READY' && !node.stale).length;
  const unreachable = nodeList.filter((node) => node.status === 'UNREACHABLE' || node.stale).length;
  const recentFailures = summary?.recentFailures || [];
  const quality = summary?.latestQuality;
  /**
   * table-spec §2.2: a column exists while it separates rows. Until a run has been sampled, every
   * dataset answers the same thing, so the quality column is not drawn and one sentence above the
   * table carries that one fact (§2.7) instead of twelve rows of it. Examined and failed are the
   * run's own counts, so they ride the run on the identity cell's second line.
   */
  const qualityMeasurable = datasets.some((dataset) => Boolean(dataset.latest));
  const number = new Intl.NumberFormat(locale);
  /**
   * table-spec §2.5: the three facts the 390 card keeps, ranked by §2.2's distinct ratio over the
   * rows on screen. The other two tables on this page already sit at 2 and 3 facts.
   */
  const cardFacts = rankCardFacts({
    schema: datasets.map((dataset) => `r${dataset.schemaRevision}`),
    quality: datasets.map((dataset) => (dataset.latest ? dataset.latest.status : '')),
  });

  return <div className="page-stack">
    <PageHeader title={t('page.governance')} description={t('governance.description')} actions={<Button variant="secondary" onClick={() => { void load(); void reloadNodes(); }}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button>} />
    {/* A policy summary is a count over observed runs: while no run has answered, the card says
        UNKNOWN instead of printing a 0 that reads like "zero failures". */}
    <AsyncBoundary
      loading={loading || nodeLoading}
      error={error}
      hasData={Boolean(summary) || datasets.length > 0}
      skeletonRows={5}
      onRetry={() => { void load(); void reloadNodes(); }}
    >
      {/* .metric-grid never had a rule in styles.css, so these cards stacked full width at
          every viewport. The grid lives here now, where this page's layout belongs. */}
      <div className="metric-grid grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="panel metric-card"><span className="metric-label">{t('governance.metric.datasets')}</span><strong>{Number.isFinite(summary?.datasetCount) ? summary!.datasetCount : <UnknownValue detail={t('ui.unknown.detail')} />}</strong><span className="text-sm text-muted-foreground">{t('governance.metric.datasets.detail')}</span></div>
        <div className="panel metric-card"><span className="metric-label">{t('governance.metric.qualityPassed')}</span><strong>{quality ? quality.passed : <UnknownValue detail={t('ui.unknown.detail')} />}</strong><span className="text-sm text-muted-foreground">{quality ? t('governance.metric.qualityPassed.detail', { failed: quality.failed, errored: quality.error, unknown: quality.unknown, pending: quality.pending }) : t('ui.notObserved')}</span></div>
        <div className="panel metric-card"><span className="metric-label">{t('governance.metric.lineageBatches')}</span><strong>{Number.isFinite(summary?.lineageWindowCount) ? summary!.lineageWindowCount : <UnknownValue detail={t('ui.unknown.detail')} />}</strong>{/* The window is the server's answer; a missing one is UNKNOWN, never a "24h" of our own. */}<span className="text-sm text-muted-foreground">{summary?.lineageWindow ? t('governance.metric.lineageBatches.detail', { window: summary.lineageWindow }) : <UnknownValue detail={t('ui.unknown.detail')} />}</span></div>
        <div className="panel metric-card"><span className="metric-label">{t('governance.metric.nodesReady')}</span><strong>{nodes ? ready : <UnknownValue detail={t('ui.unknown.detail')} />}</strong><span className="text-sm text-muted-foreground">{nodes ? t('governance.metric.nodesReady.detail', { unreachable, enrolled: nodeList.length }) : t('ui.notObserved')}</span></div>
      </div>
      <section className="panel table-panel">
        <div className="panel-head"><div><h2>{t('governance.quality.title')}</h2><p>{t('governance.quality.description')}</p></div><Link className="text-link" to="/admin/ext/trusted-team/data-catalog">{t('governance.quality.openCatalog')}</Link></div>
        {datasets.length === 0 ? <EmptyState icon="catalog" title={t('governance.quality.empty.title')} description={t('governance.quality.empty.description')} /> : (<>
          {/* M1: an Empty panel says "none" ONCE, above the table - it does not print the same
              "no runs" in twelve rows. §2.2/§2.7 owe the dropped column one sentence, and that
              sentence is where the count and the way out belong. */}
          {!qualityMeasurable ? <p className="stat-note" data-table-note="demoted:empty">{t('governance.quality.note', { total: datasets.length })}</p> : null}
          <Table className={stackTable}>
            <TableHeader className={stackHead}>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('table.dataset')}</TableHead>
                <TableHead>{t('table.schema')}</TableHead>
                {qualityMeasurable ? <TableHead>{t('table.quality')}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody className={stackBody}>
              {datasets.map((dataset) => (
                <TableRow key={dataset.datasetId} className={stackRow} data-dataset={dataset.datasetId}>
                  <IdentityCell label={t('table.dataset')} identity={formatIdentity({ name: dataset.name, id: dataset.datasetId, at: dataset.latest?.createdAt, locale, rowsOnPage: datasets.length })} cardFact>
                    {/* Examined and failed were two columns that answered nothing for every row;
                        they are the run's counts, so they are read where the run is named. A
                        dataset the catalog has never run answers zero runs - that is the source
                        saying "none", not a source that could not answer (§2.7 / M1). */}
                    {dataset.latest ? (
                      <span>
                        {dataset.latest.runId.slice(0, 8)}{' · '}
                        {t('governance.quality.counts', { examined: number.format(dataset.latest.recordsExamined), failed: number.format(dataset.latest.recordsFailed) })}
                      </span>
                    ) : qualityMeasurable ? (
                      // A single dataset with no run, inside a page that has runs: that row is the
                      // answer to its own question, so it says "no runs" where the count would go.
                      <span>{t('common.noRuns')}</span>
                    ) : null}
                    {/* Nothing here when NO dataset has a run: the sentence above the table is the
                        one place that fact is stated (M1: once, not per row). */}
                  </IdentityCell>
                  <StackCell label={t('table.schema')} className={cardCellClass(cardFacts.includes('schema'))}>r{dataset.schemaRevision}</StackCell>
                  {qualityMeasurable ? (
                    <StackCell label={t('table.quality')} className={cardCellClass(cardFacts.includes('quality'))}>{dataset.latest ? <StatusPill status={dataset.latest.status} /> : <span className="ow-cell-meta">{t('common.noRuns')}</span>}</StackCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>)}
      </section>
      <div className="governance-grid">
        <section className="panel table-panel"><div className="panel-head"><div><h2>{t('governance.failures.title')}</h2><p>{t('governance.failures.description')}</p></div></div>{recentFailures.length === 0 ? <EmptyState icon="check" title={t('governance.failures.empty.title')} /> : (
          <Table className={stackTable}>
            <TableHeader className={stackHead}>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('table.dataset')}</TableHead>
                <TableHead>{t('table.status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className={stackBody}>
              {recentFailures.map((run) => (
                <TableRow key={run.runId} className={stackRow}>
                  {/* §2.1's disambiguator, earned: the same dataset can fail twice on this page, and
                      without it the two rows carry one identity (measured 24/27 distinct). */}
                  <IdentityCell
                    label={t('table.dataset')}
                    identity={formatIdentity({
                      name: run.datasetName,
                      id: run.runId,
                      at: run.completedAt || run.createdAt,
                      locale,
                      nameIsUnique: new Set(recentFailures.map((item) => item.datasetName)).size === recentFailures.length,
                      rowsOnPage: recentFailures.length,
                    })}
                    cardFact
                  />
                  <StackCell label={t('table.status')}><StatusPill status={run.status} /></StackCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}</section>
        <section className="panel table-panel"><div className="panel-head"><div><h2>{t('governance.nodes.title')}</h2><p>{t('governance.nodes.description')}</p></div>{nodeError && <span className="text-sm text-muted-foreground">{t('governance.nodes.unavailable')}</span>}</div>{nodeList.length === 0 ? <EmptyState icon="nodes" title={t('common.noNodes')} /> : (
          <Table className={stackTable}>
            <TableHeader className={stackHead}>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('table.node')}</TableHead>
                <TableHead>{t('table.status')}</TableHead>
                <TableHead>{t('table.generation')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className={stackBody}>
              {nodeList.map((node) => (
                <TableRow key={node.id} className={stackRow}>
                  <IdentityCell label={t('table.node')} identity={formatIdentity({ name: node.name, id: node.id, at: node.lastSeenAt, locale, rowsOnPage: nodeList.length })} cardFact />
                  {/* docs/04 §4.5 C: a node that stopped reporting is STALE, which is a different
                      answer from UNREACHABLE and from a green READY. */}
                  <StackCell label={t('table.status')}><StatusIndicator state={indicatorStateForCode(node.status, { stale: node.stale, revoked: Boolean(node.revokedAt) })} /></StackCell>
                  <StackCell label={t('table.generation')}>{node.generation}</StackCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}</section>
      </div>
      <div className="info-grid"><div className="callout"><p>{t('governance.footnote.before')} <strong>{t('status.unknown')}</strong>{t('governance.footnote.after')}</p></div></div>
    </AsyncBoundary>
  </div>;
}
