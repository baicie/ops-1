import type { IndicatorState } from '../components/app/status-indicator';
import type { MessageKey } from '../i18n';
import type { AuditEvent, NodeView } from '../types';

/**
 * The reading layer of `/app/observability`: every judgement the surface makes about a sample,
 * expressed as a pure function so it can be asserted without a browser.
 *
 * One rule shapes the whole file, and it is the project's hardest (AGENTS.md MUST NOT): a
 * missing observation is never drawn as a value. A node whose heartbeat has expired is
 * UNREACHABLE, a node that answers but carries no sample is NO_DATA, and neither of them is
 * 0%. The three are distinct types below precisely so a caller cannot collapse them by
 * accident - `reading.kind` has to be destructured before a number can be read out of it.
 */

/** The telemetry this platform actually has. Zabbix is not connected; there is no fourth metric. */
export type MetricKey = 'cpu' | 'memory' | 'filesystem';

export const METRIC_KEYS: readonly MetricKey[] = ['cpu', 'memory', 'filesystem'];

/** Catalog keys for the three metrics, so a label is never built by string concatenation. */
export const METRIC_LABEL_KEYS: Record<MetricKey, MessageKey> = {
  cpu: 'table.cpu',
  memory: 'table.memory',
  filesystem: 'table.filesystem',
};

/**
 * One sample of one metric, as the page is allowed to speak about it.
 *
 * `value` exists only on the `reading` branch. That is the type doing the work the comment
 * cannot: there is no field to read a ratio out of when the source did not answer, so
 * "missing rendered as zero" is a compile error rather than a review finding.
 */
export type Reading =
  | { kind: 'reading'; value: number; observedAt: string }
  /** The node answered and the sample is absent: `NO_DATA` (machine-language M1). */
  | { kind: 'noData' }
  /** The node is not reachable, so nothing can be said about its load: `UNKNOWN`. */
  | { kind: 'unknown' };

export const NO_DATA: Reading = { kind: 'noData' };
export const UNKNOWN: Reading = { kind: 'unknown' };

/**
 * A ratio in [0,1], or `null` when the pair cannot produce one.
 *
 * `total <= 0` is not a divide-by-zero guard: a node reporting a zero-byte filesystem has told
 * us its collector is wrong, and 0/0 = NaN must not reach a chart as a point at the origin.
 */
export function ratio(used?: number | null, total?: number | null): number | null {
  if (typeof used !== 'number' || typeof total !== 'number') return null;
  if (!Number.isFinite(used) || !Number.isFinite(total)) return null;
  if (total <= 0 || used < 0) return null;
  return Math.min(1, used / total);
}

/** A utilisation the collector reports directly (CPU), kept only when it is a usable fraction. */
export function utilisation(value?: number | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0) return null;
  return Math.min(1, value);
}

/**
 * The effective observational state of a node, in the priority docs/09 §9.5 fixes: a node that
 * stopped answering can never read as healthy, whatever its stored status column says.
 */
export type EntityState = 'revoked' | 'unreachable' | 'stale' | 'degraded' | 'ready' | 'unknown';

export function entityState(node: NodeView): EntityState {
  if (node.revokedAt) return 'revoked';
  const status = (node.status || '').toUpperCase();
  if (status === 'UNREACHABLE') return 'unreachable';
  if (node.stale) return 'stale';
  // DEGRADED is a health answer, not an absence of one. The kernel accepts it from the node
  // agent (apps/kernel/src/nodes.rs:424-427) and status-tone already knows the word; folding it
  // into `unknown` made a fresh node look like one that had stopped reporting.
  if (status === 'DEGRADED') return 'degraded';
  if (status === 'READY') return 'ready';
  return 'unknown';
}

/** Whether a state permits a load reading to be believed at all. */
export function stateCanReport(state: EntityState): boolean {
  return state === 'ready' || state === 'degraded' || state === 'stale';
}

/**
 * The shell's indicator vocabulary for an entity state.
 *
 * Shared by the list and the detail page rather than written twice: the same node must not be
 * `stale` amber in the table and `unknown` grey on its own page, which is exactly the "two
 * surfaces, two spellings of one state" defect status-tone.ts exists to prevent.
 *
 * The map is written out even though the five names currently coincide with five
 * `IndicatorState` members: the coincidence is not a contract, and a silent `return state`
 * would start mis-rendering the day either vocabulary gains a member.
 */
const INDICATOR_BY_STATE: Record<EntityState, IndicatorState> = {
  revoked: 'revoked',
  unreachable: 'unreachable',
  stale: 'stale',
  degraded: 'degraded',
  ready: 'ready',
  unknown: 'unknown',
};

export function indicatorForEntityState(state: EntityState): IndicatorState {
  return INDICATOR_BY_STATE[state];
}

/**
 * The three readings for one node.
 *
 * The state gate comes first and is the reason this is not three independent ratio calls: a
 * revoked or unreachable node may still carry the last snapshot it ever sent, and printing
 * that 4% as the node's CPU is exactly the "offline inferred as fine" defect the rules forbid.
 * Such a node reports UNKNOWN - we are not looking, so we do not know - while a reachable node
 * with no sample reports NO_DATA, because the source exists and simply has nothing yet.
 */
export function nodeReadings(node: NodeView): Record<MetricKey, Reading> {
  const state = entityState(node);
  if (!stateCanReport(state)) return { cpu: UNKNOWN, memory: UNKNOWN, filesystem: UNKNOWN };
  const snapshot = node.resourceSnapshot;
  if (!snapshot || !snapshot.sampledAt) return { cpu: NO_DATA, memory: NO_DATA, filesystem: NO_DATA };
  const at = snapshot.sampledAt;
  const read = (value: number | null): Reading => (value === null ? NO_DATA : { kind: 'reading', value, observedAt: at });
  return {
    cpu: read(utilisation(snapshot.cpuUtilization)),
    memory: read(ratio(snapshot.memoryUsedBytes, snapshot.memoryTotalBytes)),
    filesystem: read(ratio(snapshot.filesystemUsedBytes, snapshot.filesystemTotalBytes)),
  };
}

/**
 * How old a sample may be before the page stops presenting it as current.
 *
 * The kernel heartbeats every 5s (`OPSWEAVE_NODE_HEARTBEAT_SECONDS`) and samples ride the same
 * channel, so 120s is 24 missed rounds: long enough that a slow collector or a restarted agent
 * is not called stale, short enough that a reader is never shown a minutes-old load as "now".
 * A node the kernel itself already calls stale is stale regardless of this number.
 */
export const SAMPLE_STALE_AFTER_MS = 120_000;

export function sampleIsStale(observedAt: string | null | undefined, now = Date.now()): boolean {
  if (!observedAt) return false;
  const at = Date.parse(observedAt);
  if (Number.isNaN(at)) return false;
  return now - at > SAMPLE_STALE_AFTER_MS;
}

/** The newest observation across a fleet, or null when nothing has been observed at all. */
export function newestObservation(nodes: NodeView[]): string | null {
  let newest: number | null = null;
  let iso: string | null = null;
  for (const node of nodes) {
    const at = node.resourceSnapshot?.sampledAt;
    if (!at) continue;
    const parsed = Date.parse(at);
    if (Number.isNaN(parsed)) continue;
    if (newest === null || parsed > newest) { newest = parsed; iso = at; }
  }
  return iso;
}

/* ── the KPI band: one row, and every number is a count of observations ───────── */

/**
 * What the band may claim.
 *
 * `reporting` is not `total - unreachable`: it counts the nodes that actually produced a
 * sample, so the band's denominator and the table's rows agree. `coverage` is therefore a
 * measured fraction of the fleet and never an assumption about the ones we cannot see.
 */
export interface FleetSummary {
  total: number;
  /** Nodes whose state permits a reading AND that carried a sample. */
  reporting: number;
  /** Reachable, but no sample in the snapshot: the NO_DATA population. */
  noSample: number;
  /** Not reachable (unreachable / revoked / unknown state): the UNKNOWN population. */
  notObservable: number;
  /** Nodes whose newest sample is older than {@link SAMPLE_STALE_AFTER_MS}. */
  staleSamples: number;
  /** Highest CPU utilisation among reporting nodes, with the node it belongs to. */
  peakCpu: { value: number; nodeId: string; nodeName: string; observedAt: string } | null;
  /** Highest memory utilisation among reporting nodes. */
  peakMemory: { value: number; nodeId: string; nodeName: string; observedAt: string } | null;
  /** The newest observation anywhere in the fleet. */
  observedAt: string | null;
}

export function summarise(nodes: NodeView[], now = Date.now()): FleetSummary {
  const summary: FleetSummary = {
    total: nodes.length,
    reporting: 0,
    noSample: 0,
    notObservable: 0,
    staleSamples: 0,
    peakCpu: null,
    peakMemory: null,
    observedAt: newestObservation(nodes),
  };
  for (const node of nodes) {
    const state = entityState(node);
    if (!stateCanReport(state)) { summary.notObservable += 1; continue; }
    const readings = nodeReadings(node);
    const any = METRIC_KEYS.some((key) => readings[key].kind === 'reading');
    if (!any) { summary.noSample += 1; continue; }
    summary.reporting += 1;
    const at = node.resourceSnapshot?.sampledAt;
    if (sampleIsStale(at, now)) summary.staleSamples += 1;
    const cpu = readings.cpu;
    if (cpu.kind === 'reading' && (!summary.peakCpu || cpu.value > summary.peakCpu.value)) {
      summary.peakCpu = { value: cpu.value, nodeId: node.id, nodeName: node.name, observedAt: cpu.observedAt };
    }
    const memory = readings.memory;
    if (memory.kind === 'reading' && (!summary.peakMemory || memory.value > summary.peakMemory.value)) {
      summary.peakMemory = { value: memory.value, nodeId: node.id, nodeName: node.name, observedAt: memory.observedAt };
    }
  }
  return summary;
}

/* ── the entity table ────────────────────────────────────────────────────────── */

/** One row of the fleet table: the entity, its state, and what it reported. */
export interface EntityRow {
  node: NodeView;
  state: EntityState;
  readings: Record<MetricKey, Reading>;
  /**
   * The node's instance count, or `null` when this state cannot report one.
   *
   * `instances_ready` / `instances_total` are rows the kernel stores, not an observation of the
   * node, so a node whose heartbeat expired still carries whatever the numbers were when it was
   * last seen. Rendering `0/2 ready` for a node nobody can reach is the same claim as rendering
   * `0%` CPU for it: "nothing is running" when the truth is "we are not looking". Gated by the
   * same `stateCanReport` the readings use, so both faces of the row come from one rule.
   */
  instances: { ready: number; total: number } | null;
  /** The sample's own timestamp, never the time the page rendered. */
  observedAt: string | null;
  stale: boolean;
}

export function entityRows(nodes: NodeView[], now = Date.now()): EntityRow[] {
  return nodes.map((node) => {
    const observedAt = node.resourceSnapshot?.sampledAt ?? null;
    const state = entityState(node);
    return {
      node,
      state,
      readings: nodeReadings(node),
      // The two counts are required by the wire type, but an absent pair is not 0/0: the old
      // `?? 0` fallback would print "0 of 0 ready" for a node whose counts never arrived, which
      // is the same absence-as-a-number defect the readings type prevents.
      instances:
        stateCanReport(state)
        && typeof node.instancesReady === 'number'
        && typeof node.instancesTotal === 'number'
          ? { ready: node.instancesReady, total: node.instancesTotal }
          : null,
      observedAt,
      stale: sampleIsStale(observedAt, now),
    };
  });
}

/**
 * Severity for sorting: the rows a reader must act on first.
 *
 * Unobservable outranks loaded on purpose. A node at 97% CPU is a known problem with a known
 * number; a node we cannot see might be at 100% or might be gone, and that uncertainty is the
 * more urgent of the two. Load only breaks ties among nodes that are actually reporting.
 */
export function rowSeverity(row: EntityRow): number {
  if (row.state === 'unreachable') return 4;
  if (row.state === 'revoked') return 3;
  if (row.state === 'unknown') return 3;
  // "Reporting" is the same predicate `summarise` uses: ANY metric with a reading. Testing only
  // CPU and memory counted a filesystem-only node on the KPI card but dropped it from the
  // `?state=reporting` list the card links to.
  if (!METRIC_KEYS.some((key) => row.readings[key].kind === 'reading')) return 2;
  if (row.stale || row.state === 'stale' || row.state === 'degraded') return 1;
  return 0;
}

/** The worst load a reporting row shows, for the secondary sort. Unreadable rows sort last. */
export function rowLoad(row: EntityRow): number {
  let worst = -1;
  for (const key of METRIC_KEYS) {
    const reading = row.readings[key];
    if (reading.kind === 'reading' && reading.value > worst) worst = reading.value;
  }
  return worst;
}

/** Severity first, then load, then name: a stable order that puts the answerable last. */
export function sortRows(rows: EntityRow[]): EntityRow[] {
  return rows.slice().sort((left, right) =>
    (rowSeverity(right) - rowSeverity(left))
    || (rowLoad(right) - rowLoad(left))
    || left.node.name.localeCompare(right.node.name));
}

export type EntityFilter = 'all' | 'attention' | 'reporting' | 'unobservable';

export function filterRows(rows: EntityRow[], filter: EntityFilter): EntityRow[] {
  if (filter === 'all') return rows;
  if (filter === 'attention') return rows.filter((row) => rowSeverity(row) >= 1);
  if (filter === 'reporting') return rows.filter((row) => rowSeverity(row) <= 1 && rowLoad(row) >= 0);
  return rows.filter((row) => rowSeverity(row) >= 2);
}

/**
 * Whether the fleet table may carry a load column at all (machine-language M1).
 *
 * A column that would print `NO_DATA` in half its rows is not a column: at that ratio the
 * dashed boxes are the majority of its pixels and the column communicates one fact, which is
 * cheaper to state once above the table. The threshold is the spec's 0.5.
 */
export const NO_DATA_COLUMN_LIMIT = 0.5;

export function loadColumnEarnsWidth(rows: EntityRow[]): boolean {
  if (rows.length === 0) return false;
  const missing = rows.filter((row) => row.readings.cpu.kind !== 'reading' && row.readings.memory.kind !== 'reading').length;
  return missing / rows.length < NO_DATA_COLUMN_LIMIT;
}

/* ── the time series ─────────────────────────────────────────────────────────── */

/** One sample row of `GET /api/v1/nodes/{id}/resource-history`, as this page reads it. */
export interface HistorySample {
  sampleId: number;
  generation: number;
  observedAt: string;
  sampledAt?: string | null;
  cpuUtilization?: number | null;
  memoryUsedBytes?: number | null;
  memoryTotalBytes?: number | null;
  filesystemUsedBytes?: number | null;
  filesystemTotalBytes?: number | null;
  cpuCores?: number | null;
}

/** The metric's value for one sample, as a ratio, or null when that sample cannot answer. */
export function sampleRatio(sample: HistorySample, metric: MetricKey): number | null {
  if (metric === 'cpu') return utilisation(sample.cpuUtilization);
  if (metric === 'memory') return ratio(sample.memoryUsedBytes, sample.memoryTotalBytes);
  return ratio(sample.filesystemUsedBytes, sample.filesystemTotalBytes);
}

/** A plotted point: x in [0,1] across the window, y the ratio in [0,1]. */
export interface SeriesPoint {
  x: number;
  y: number;
  at: string;
  value: number;
}

/**
 * The window a series is drawn over. Fixed by the caller, not derived from the data, so a
 * window with two samples in its last minute draws two points at the right-hand edge rather
 * than stretching them across the whole axis as if they covered an hour.
 */
export interface SeriesWindow {
  fromMs: number;
  toMs: number;
}

/**
 * A series split into the runs that may be joined by a line.
 *
 * This is the chart half of "never draw missing as zero". A gap in the samples is a gap in the
 * line: the polyline ENDS and a new one starts, so the reader sees the hole instead of a
 * segment sloping through it. Three things break a run, each of them a different fact:
 *
 *   - a sample whose ratio is null (the collector answered without this metric);
 *   - a time gap wider than `maxGapMs` (nothing was collected in between);
 *   - a generation change (the agent restarted, so the two sides are different processes and a
 *     line across them would assert continuity the platform cannot promise).
 */
export interface Series {
  metric: MetricKey;
  segments: SeriesPoint[][];
  /** Points actually plotted, across every segment. */
  plotted: number;
  /** Samples the window held that could not be plotted. */
  missing: number;
  /** Breaks in the line: one per discontinuity, not counting the ends. */
  gaps: number;
  /** Highest plotted value, for the panel's own summary. */
  peak: SeriesPoint | null;
  newest: SeriesPoint | null;
}

export function buildSeries(
  samples: HistorySample[],
  metric: MetricKey,
  window: SeriesWindow,
  maxGapMs: number,
): Series {
  const span = Math.max(1, window.toMs - window.fromMs);
  const ordered = samples
    .map((sample) => ({ sample, at: Date.parse(sample.observedAt) }))
    .filter((entry) => !Number.isNaN(entry.at))
    .sort((left, right) => left.at - right.at);

  const series: Series = { metric, segments: [], plotted: 0, missing: 0, gaps: 0, peak: null, newest: null };
  let current: SeriesPoint[] = [];
  let previous: { at: number; generation: number } | null = null;

  const closeSegment = () => {
    if (current.length) series.segments.push(current);
    current = [];
  };

  for (const entry of ordered) {
    const value = sampleRatio(entry.sample, metric);
    if (value === null) {
      // The sample exists but this metric is absent: the line stops here. Counting it as
      // missing is what lets the panel say "4 of 60 samples carried no memory reading"
      // instead of drawing a dip to the axis.
      series.missing += 1;
      if (current.length) { closeSegment(); series.gaps += 1; }
      previous = { at: entry.at, generation: entry.sample.generation };
      continue;
    }
    const broken = previous !== null
      && (entry.at - previous.at > maxGapMs || entry.sample.generation !== previous.generation);
    if (broken && current.length) { closeSegment(); series.gaps += 1; }
    const point: SeriesPoint = {
      x: Math.min(1, Math.max(0, (entry.at - window.fromMs) / span)),
      y: value,
      at: entry.sample.observedAt,
      value,
    };
    current.push(point);
    series.plotted += 1;
    if (!series.peak || point.value > series.peak.value) series.peak = point;
    series.newest = point;
    previous = { at: entry.at, generation: entry.sample.generation };
  }
  closeSegment();
  return series;
}

/**
 * An SVG path for one segment, in the chart's own viewBox.
 *
 * A single point becomes a 0-length line, which an SVG renderer draws as nothing; the caller
 * therefore also renders a dot per point, so a window holding one lone sample is visible as
 * that one sample rather than as an empty box.
 */
export function segmentPath(segment: SeriesPoint[], width: number, height: number): string {
  return segment
    .map((point, index) => {
      const x = (point.x * width).toFixed(2);
      const y = ((1 - point.y) * height).toFixed(2);
      return `${index === 0 ? 'M' : 'L'}${x},${y}`;
    })
    .join(' ');
}

/** The windows the detail page offers, in hours, with the sample resolution each one asks for. */
export const HISTORY_WINDOWS = [1, 6, 24] as const;
export type HistoryWindowHours = (typeof HISTORY_WINDOWS)[number];

/**
 * The gap that breaks a line, per window.
 *
 * At raw resolution samples arrive every few seconds, so a minute of silence is a real hole.
 * The 24h window is served hour-bucketed, where consecutive points are an hour apart by
 * construction - a one-minute rule there would break every single segment, which is why the
 * tolerance scales with the bucket instead of being one constant.
 */
export function maxGapFor(hours: HistoryWindowHours): number {
  return hours >= 24 ? 150 * 60_000 : hours >= 6 ? 15 * 60_000 : 60_000;
}

export function resolutionFor(hours: HistoryWindowHours): 'raw' | 'hour' {
  return hours >= 24 ? 'hour' : 'raw';
}

/* ── events on the entity page ───────────────────────────────────────────────── */

/**
 * Consecutive audit rows that state the same fact, folded into one (table-spec §2.4).
 *
 * Threshold 3, and the reason is the spec's: two identical rows can be two genuine actions, so
 * folding a pair would hide an event; three in a row can only be a poller, a fan-out or a
 * retry loop, where the only information left is how many times.
 */
export const EVENT_RUN_THRESHOLD = 3;

export interface EventRun {
  event: AuditEvent;
  count: number;
  firstAt: string;
  lastAt: string;
}

export function foldEvents(events: AuditEvent[], threshold = EVENT_RUN_THRESHOLD): EventRun[] {
  const runs: EventRun[] = [];
  const key = (event: AuditEvent) => [event.eventType, event.action, event.result].join('\u0000');
  let index = 0;
  while (index < events.length) {
    let end = index;
    while (end + 1 < events.length && key(events[end + 1]) === key(events[index])) end += 1;
    const members = events.slice(index, end + 1);
    if (members.length >= threshold) {
      runs.push({
        event: members[0],
        count: members.length,
        // The list arrives newest-first, so the run's first occurrence is its last member.
        firstAt: members[members.length - 1].occurredAt,
        lastAt: members[0].occurredAt,
      });
    } else {
      for (const member of members) {
        runs.push({ event: member, count: 1, firstAt: member.occurredAt, lastAt: member.occurredAt });
      }
    }
    index = end + 1;
  }
  return runs;
}
