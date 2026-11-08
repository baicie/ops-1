import { describe, expect, it } from 'vitest';
import type { AuditEvent, NodeView } from '@opsweave/platform-client/contracts';
import {
  SAMPLE_STALE_AFTER_MS,
  buildSeries,
  entityRows,
  entityState,
  filterRows,
  foldEvents,
  loadColumnEarnsWidth,
  maxGapFor,
  newestObservation,
  nodeReadings,
  ratio,
  resolutionFor,
  rowLoad,
  rowSeverity,
  sampleIsStale,
  segmentPath,
  sortRows,
  summarise,
  utilisation,
  type HistorySample,
  type SeriesWindow,
} from './observability-model';

/**
 * Every assertion here is a place the surface could tell a lie that a type cannot catch: a
 * missing sample drawn as 0%, an unreachable node counted as healthy, a gap in a series joined
 * into a line through the origin, or a KPI whose denominator includes the nodes it cannot see.
 *
 * The project's hardest rule (AGENTS.md MUST NOT: "把 UNKNOWN、PARTIAL、NO_DATA 伪装成健康状态")
 * has no compiler behind it, so it has tests.
 */

/**
 * One clock for the whole file. Every age below is derived from it rather than from a fresh
 * `Date.now()` per call, so a case that asserts a staleness boundary cannot flake on the
 * millisecond that elapses between building the fixture and reading it.
 */
const NOW = Date.parse('2026-11-01T12:00:00.000Z');

const ago = (ms: number) => new Date(NOW - ms).toISOString();

function node(over: Partial<NodeView> = {}): NodeView {
  return {
    id: '1285fbe8-9bb8-459f-b073-af245d32b3ae',
    name: 'node-a',
    generation: 4,
    os: 'linux',
    arch: 'arm64',
    labels: {},
    capabilities: [],
    status: 'READY',
    lastSeenAt: ago(3_000),
    enrolledAt: ago(86_400_000),
    stale: false,
    instancesReady: 1,
    instancesTotal: 1,
    resourceSnapshot: {
      sampledAt: ago(5_000),
      cpuUtilization: 0.42,
      memoryUsedBytes: 4 * 1024 ** 3,
      memoryTotalBytes: 8 * 1024 ** 3,
      filesystemUsedBytes: 10 * 1024 ** 3,
      filesystemTotalBytes: 100 * 1024 ** 3,
    },
    ...over,
  };
}

describe('ratio and utilisation', () => {
  it('refuses a pair that cannot produce a fraction instead of returning zero', () => {
    // Each of these used to be a plausible 0%: a zero-byte total, a negative counter, a missing
    // half of the pair. A chart point at the origin is a claim, so there must be no number here.
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(4, 0)).toBeNull();
    expect(ratio(4, -1)).toBeNull();
    expect(ratio(-1, 100)).toBeNull();
    expect(ratio(4, null)).toBeNull();
    expect(ratio(undefined, 100)).toBeNull();
    expect(ratio(Number.NaN, 100)).toBeNull();
    expect(ratio(Number.POSITIVE_INFINITY, 100)).toBeNull();
  });

  it('keeps a real fraction and clamps an over-report to 1', () => {
    expect(ratio(2, 8)).toBe(0.25);
    // A collector that reports used > total is wrong, but it is not *missing*: clamping keeps the
    // row readable while the number stays at the top of the scale.
    expect(ratio(12, 8)).toBe(1);
    expect(utilisation(0.42)).toBe(0.42);
    expect(utilisation(1.4)).toBe(1);
    expect(utilisation(-0.1)).toBeNull();
    expect(utilisation(null)).toBeNull();
  });

  it('keeps a genuine zero, which is an answer and not an absence', () => {
    // The mirror of the rule above: an idle CPU really is 0, and erasing it would be the same
    // class of lie in the other direction.
    expect(utilisation(0)).toBe(0);
    expect(ratio(0, 100)).toBe(0);
  });
});

describe('entityState', () => {
  it('never lets a node that stopped answering read as ready', () => {
    expect(entityState(node({ status: 'READY', stale: true }))).toBe('stale');
    expect(entityState(node({ status: 'UNREACHABLE' }))).toBe('unreachable');
    // Revocation outranks everything, including a status column that still says READY.
    expect(entityState(node({ status: 'READY', revokedAt: ago(1_000) }))).toBe('revoked');
    expect(entityState(node({ status: 'READY' }))).toBe('ready');
    expect(entityState(node({ status: 'WAT' }))).toBe('unknown');
  });

  it('keeps DEGRADED as a health answer, and lets staleness outrank it', () => {
    // A fresh DEGRADED node used to be folded into `unknown`, then explained as an expired
    // heartbeat. It is a reachable node with a health answer of its own.
    expect(entityState(node({ status: 'DEGRADED' }))).toBe('degraded');
    expect(entityState(node({ status: 'DEGRADED', stale: true }))).toBe('stale');
  });
});

describe('nodeReadings', () => {
  it('reads the three metrics the platform actually collects', () => {
    const readings = nodeReadings(node());
    expect(readings.cpu).toEqual({ kind: 'reading', value: 0.42, observedAt: expect.any(String) });
    expect(readings.memory.kind === 'reading' && readings.memory.value).toBe(0.5);
    expect(readings.filesystem.kind === 'reading' && readings.filesystem.value).toBe(0.1);
  });

  it('answers UNKNOWN for every metric of an unreachable node, not 0 and not NO_DATA', () => {
    // The distinction is the point: NO_DATA means "we asked and there is no sample", UNKNOWN
    // means "we could not ask". A node we cannot reach may be perfectly busy.
    const readings = nodeReadings(node({ status: 'UNREACHABLE' }));
    expect(readings.cpu.kind).toBe('unknown');
    expect(readings.memory.kind).toBe('unknown');
    expect(readings.filesystem.kind).toBe('unknown');
  });

  it('lets a DEGRADED node report: degraded is a health answer, not an absence', () => {
    const readings = nodeReadings(node({ status: 'DEGRADED' }));
    expect(readings.cpu.kind).toBe('reading');
    expect(readings.memory.kind).toBe('reading');
  });

  it('answers NO_DATA when the node is reachable but carries no snapshot', () => {
    const readings = nodeReadings(node({ resourceSnapshot: null }));
    expect(readings.cpu.kind).toBe('noData');
    expect(readings.memory.kind).toBe('noData');
  });

  it('answers NO_DATA per metric, so one missing field does not erase the others', () => {
    const readings = nodeReadings(node({
      resourceSnapshot: {
        sampledAt: ago(5_000),
        cpuUtilization: 0.9,
        memoryUsedBytes: null,
        memoryTotalBytes: null,
        filesystemUsedBytes: null,
        filesystemTotalBytes: null,
      },
    }));
    expect(readings.cpu.kind).toBe('reading');
    expect(readings.memory.kind).toBe('noData');
    expect(readings.filesystem.kind).toBe('noData');
  });

  it('carries the sample’s own timestamp, never the render time', () => {
    const at = ago(5_000);
    const readings = nodeReadings(node({ resourceSnapshot: { sampledAt: at, cpuUtilization: 0.1 } }));
    expect(readings.cpu.kind === 'reading' && readings.cpu.observedAt).toBe(at);
  });
});

describe('entityRows - the instance count is gated like every other reading', () => {
  it('carries the stored count for a node that can report', () => {
    const [row] = entityRows([node({ instancesReady: 2, instancesTotal: 3 })], NOW);
    expect(row.instances).toEqual({ ready: 2, total: 3 });
  });

  it('drops the count for a node nobody can reach, instead of printing "0/2 ready"', () => {
    // The count is a stored row, not an observation. An unreachable node still carries whatever
    // it was last seen with; rendering it asserts a fact about NOW that we cannot have.
    const [row] = entityRows([node({ status: 'UNREACHABLE', instancesReady: 0, instancesTotal: 2 })], NOW);
    expect(row.state).toBe('unreachable');
    expect(row.instances).toBeNull();
  });

  it('drops the count for a revoked node on the same rule', () => {
    const [row] = entityRows([node({ revokedAt: ago(60_000), instancesReady: 1, instancesTotal: 1 })], NOW);
    expect(row.instances).toBeNull();
  });

  it('keeps the count for a stale-but-answering node, because a stale count is still a count', () => {
    const [row] = entityRows([node({
      instancesReady: 1,
      instancesTotal: 4,
      // `stale` is the kernel's heartbeat flag (entityState reads it, not the sample age), and a
      // stale node is still a node that answered - unlike unreachable, it may report.
      stale: true,
      resourceSnapshot: { sampledAt: ago(10 * 60_000), cpuUtilization: 0.42 },
    })], NOW);
    expect(row.state).toBe('stale');
    expect(row.instances).toEqual({ ready: 1, total: 4 });
  });

  it('keeps the count for a DEGRADED node, because it is still answering', () => {
    const [row] = entityRows([node({ status: 'DEGRADED', instancesReady: 2, instancesTotal: 3 })], NOW);
    expect(row.state).toBe('degraded');
    expect(row.instances).toEqual({ ready: 2, total: 3 });
  });

  it('does not turn an absent pair into 0/0', () => {
    const [row] = entityRows([node({
      instancesReady: undefined as unknown as number,
      instancesTotal: undefined as unknown as number,
    })], NOW);
    expect(row.instances).toBeNull();
  });
});

describe('sampleIsStale', () => {
  it('is false for a fresh sample and true past the window', () => {
    const now = Date.now();
    expect(sampleIsStale(new Date(now - 1_000).toISOString(), now)).toBe(false);
    expect(sampleIsStale(new Date(now - SAMPLE_STALE_AFTER_MS - 1_000).toISOString(), now)).toBe(true);
  });

  it('does not call a missing or unparseable timestamp stale - that is NO_DATA, a different fact', () => {
    expect(sampleIsStale(null)).toBe(false);
    expect(sampleIsStale(undefined)).toBe(false);
    expect(sampleIsStale('not a date')).toBe(false);
  });
});

describe('newestObservation', () => {
  it('returns the newest sample across the fleet, ignoring the unparseable', () => {
    const newer = ago(1_000);
    const result = newestObservation([
      node({ resourceSnapshot: { sampledAt: ago(60_000), cpuUtilization: 0.1 } }),
      node({ resourceSnapshot: { sampledAt: newer, cpuUtilization: 0.2 } }),
      node({ resourceSnapshot: null }),
    ]);
    expect(result).toBe(newer);
  });

  it('returns null for a fleet with no samples at all', () => {
    expect(newestObservation([node({ resourceSnapshot: null })])).toBeNull();
    expect(newestObservation([])).toBeNull();
  });
});

describe('summarise', () => {
  it('counts observations, and never folds the unseen into the healthy', () => {
    const summary = summarise([
      node({ id: 'a', name: 'a', resourceSnapshot: { sampledAt: ago(2_000), cpuUtilization: 0.2, memoryUsedBytes: 1, memoryTotalBytes: 4 } }),
      node({ id: 'b', name: 'b', resourceSnapshot: { sampledAt: ago(2_000), cpuUtilization: 0.9, memoryUsedBytes: 3, memoryTotalBytes: 4 } }),
      // reachable, no sample -> NO_DATA population
      node({ id: 'c', name: 'c', resourceSnapshot: null }),
      // unreachable -> UNKNOWN population, and NOT counted as reporting
      node({ id: 'd', name: 'd', status: 'UNREACHABLE' }),
    ], NOW);
    expect(summary.total).toBe(4);
    expect(summary.reporting).toBe(2);
    expect(summary.noSample).toBe(1);
    expect(summary.notObservable).toBe(1);
    // The three populations partition the fleet: nothing is silently dropped or double-counted.
    expect(summary.reporting + summary.noSample + summary.notObservable).toBe(summary.total);
  });

  it('counts a DEGRADED node that reports as reporting, not as unobservable', () => {
    const summary = summarise([node({ status: 'DEGRADED' })], NOW);
    expect(summary.reporting).toBe(1);
    expect(summary.noSample).toBe(0);
    expect(summary.notObservable).toBe(0);
  });

  it('attributes the peak to the node and the sample time it came from', () => {
    const summary = summarise([
      node({ id: 'a', name: 'quiet', resourceSnapshot: { sampledAt: ago(2_000), cpuUtilization: 0.2 } }),
      node({ id: 'b', name: 'busy', resourceSnapshot: { sampledAt: ago(2_000), cpuUtilization: 0.97 } }),
    ], NOW);
    expect(summary.peakCpu?.value).toBe(0.97);
    expect(summary.peakCpu?.nodeName).toBe('busy');
    expect(summary.peakCpu?.observedAt).toEqual(expect.any(String));
  });

  it('reports no peak rather than 0 when nothing is reporting', () => {
    // A band that prints "0%" for a fleet it cannot see is the exact defect this page exists to
    // avoid. null is what the card needs in order to render NO_DATA instead.
    const summary = summarise([node({ status: 'UNREACHABLE' }), node({ id: 'z', resourceSnapshot: null })], NOW);
    expect(summary.peakCpu).toBeNull();
    expect(summary.peakMemory).toBeNull();
    expect(summary.reporting).toBe(0);
  });

  it('counts a stale sample as reporting and as stale, which are two separate facts', () => {
    const summary = summarise([node({
      resourceSnapshot: { sampledAt: ago(SAMPLE_STALE_AFTER_MS + 10_000), cpuUtilization: 0.3 },
    })], NOW);
    expect(summary.reporting).toBe(1);
    expect(summary.staleSamples).toBe(1);
    expect(summary.staleRows).toBe(1);
    expect(summary.attention).toBe(1);
  });

  it('counts a kernel-stale row with a fresh sample as stale, which is the filter it links to', () => {
    const summary = summarise([node({
      status: 'UNREACHABLE',
      stale: true,
      resourceSnapshot: { sampledAt: ago(2_000), cpuUtilization: 0.3 },
    })], NOW);
    // The kernel says the node is stale even though the last sample is recent. The card and
    // the ?state=stale list must both include it.
    const [row] = entityRows([node({
      status: 'UNREACHABLE',
      stale: true,
      resourceSnapshot: { sampledAt: ago(2_000), cpuUtilization: 0.3 },
    })], NOW);
    expect(summary.staleRows).toBe(1);
    expect(filterRows([row], 'stale')).toHaveLength(1);
  });

  it('counts attention once per row, with the state buckets that explain it', () => {
    const summary = summarise([
      node({ id: 'a', name: 'a', resourceSnapshot: { sampledAt: ago(2_000), cpuUtilization: 0.2 } }),
      node({ id: 'b', name: 'b', status: 'DEGRADED', resourceSnapshot: { sampledAt: ago(2_000), cpuUtilization: 0.3 } }),
      node({ id: 'c', name: 'c', resourceSnapshot: null }),
      node({ id: 'd', name: 'd', status: 'UNREACHABLE' }),
      node({ id: 'e', name: 'e', status: 'UNKNOWN' }),
      node({ id: 'f', name: 'f', revokedAt: ago(60_000) }),
    ], NOW);
    // a is healthy; b is degraded; c has no sample; d/e not observable; f revoked.
    expect(summary.attention).toBe(5);
    expect(summary.degraded).toBe(1);
    expect(summary.unreachable).toBe(1);
    expect(summary.unknown).toBe(1);
    expect(summary.revoked).toBe(1);
    expect(summary.noSample).toBe(1);
    expect(summary.staleStates).toBe(0);
    expect(
      summary.degraded + summary.staleStates + summary.staleReadySamples
      + summary.unreachable + summary.unknown + summary.revoked + summary.noSample,
    ).toBe(summary.attention);
  });

  it('gives one reason bucket per attention row when a state and a sample are both absent', () => {
    const summary = summarise([node({ status: 'DEGRADED', resourceSnapshot: null })], NOW);
    expect(summary.attention).toBe(1);
    expect(summary.noSample).toBe(1);
    expect(summary.degraded).toBe(0);
  });

  it('keeps the oldest reporting sample for the freshness card', () => {
    const summary = summarise([
      node({ id: 'a', name: 'a', resourceSnapshot: { sampledAt: ago(1_000), cpuUtilization: 0.2 } }),
      node({ id: 'b', name: 'b', resourceSnapshot: { sampledAt: ago(40_000), cpuUtilization: 0.3 } }),
    ], NOW);
    expect(summary.oldestReportingSampleAt).toBe(ago(40_000));
  });
});

describe('row ordering and filtering', () => {
  const rows = () => entityRows([
    node({ id: 'ok', name: 'ok', resourceSnapshot: { sampledAt: ago(2_000), cpuUtilization: 0.1 } }),
    node({ id: 'busy', name: 'busy', resourceSnapshot: { sampledAt: ago(2_000), cpuUtilization: 0.95 } }),
    node({ id: 'gone', name: 'gone', status: 'UNREACHABLE' }),
    node({ id: 'blank', name: 'blank', resourceSnapshot: null }),
  ], NOW);

  it('puts what cannot be seen above what is merely loaded', () => {
    const order = sortRows(rows()).map((row) => row.node.id);
    // 'gone' (unreachable) outranks 'blank' (no sample) outranks 'busy' (95% but answered).
    expect(order).toEqual(['gone', 'blank', 'busy', 'ok']);
  });

  it('sorts unreadable rows last by load rather than treating them as idle', () => {
    const [unreachable] = entityRows([node({ status: 'UNREACHABLE' })], NOW);
    expect(rowLoad(unreachable)).toBe(-1);
    expect(rowSeverity(unreachable)).toBe(4);
  });

  it('filters by what the reader is asking about', () => {
    const all = rows();
    expect(filterRows(all, 'all')).toHaveLength(4);
    expect(filterRows(all, 'unobservable').map((row) => row.node.id)).toEqual(['gone', 'blank']);
    expect(filterRows(all, 'reporting').map((row) => row.node.id).sort()).toEqual(['busy', 'ok']);
  });

  it('filters the stale population without turning a fresh node into a stale one', () => {
    const all = entityRows([
      node({ id: 'fresh', name: 'fresh', resourceSnapshot: { sampledAt: ago(2_000), cpuUtilization: 0.1 } }),
      node({ id: 'stale', name: 'stale', stale: true, resourceSnapshot: { sampledAt: ago(SAMPLE_STALE_AFTER_MS + 10_000), cpuUtilization: 0.2 } }),
    ], NOW);
    expect(filterRows(all, 'stale').map((row) => row.node.id)).toEqual(['stale']);

    const mixed = entityRows([
      node({ id: 'ready-old', name: 'ready-old', resourceSnapshot: { sampledAt: ago(SAMPLE_STALE_AFTER_MS + 10_000), cpuUtilization: 0.2 } }),
    ], NOW);
    expect(filterRows(mixed, 'stale').map((row) => row.node.id)).toEqual(['ready-old']);
  });

  it('uses the same reporting predicate the KPI card counts', () => {
    // A filesystem-only row used to be counted on the card but dropped from the list the card
    // links to, because rowSeverity tested CPU and memory alone.
    const [filesystemOnly] = entityRows([node({
      id: 'fs',
      name: 'fs',
      resourceSnapshot: {
        sampledAt: ago(2_000),
        cpuUtilization: null,
        memoryUsedBytes: null,
        memoryTotalBytes: null,
        filesystemUsedBytes: 10,
        filesystemTotalBytes: 100,
      },
    })], NOW);
    expect(rowLoad(filesystemOnly)).toBeGreaterThanOrEqual(0);
    expect(filterRows([filesystemOnly], 'reporting')).toHaveLength(1);
    expect(filterRows([filesystemOnly], 'unobservable')).toHaveLength(0);

    const [degraded] = entityRows([node({ id: 'deg', name: 'deg', status: 'DEGRADED' })], NOW);
    expect(rowSeverity(degraded)).toBe(1);
    expect(filterRows([degraded], 'attention').map((row) => row.node.id)).toEqual(['deg']);
  });
});

describe('loadColumnEarnsWidth', () => {
  it('drops the column once half the rows would print NO_DATA', () => {
    const half = entityRows([
      node({ id: 'a', resourceSnapshot: { sampledAt: ago(1_000), cpuUtilization: 0.3 } }),
      node({ id: 'b', resourceSnapshot: null }),
    ], NOW);
    expect(loadColumnEarnsWidth(half)).toBe(false);

    const mostly = entityRows([
      node({ id: 'a', resourceSnapshot: { sampledAt: ago(1_000), cpuUtilization: 0.3 } }),
      node({ id: 'b', resourceSnapshot: { sampledAt: ago(1_000), cpuUtilization: 0.4 } }),
      node({ id: 'c', resourceSnapshot: null }),
    ], NOW);
    expect(loadColumnEarnsWidth(mostly)).toBe(true);
  });

  it('does not claim a column for an empty table', () => {
    expect(loadColumnEarnsWidth([])).toBe(false);
  });
});

describe('buildSeries', () => {
  const sample = (minutesAgo: number, cpu: number | null, over: Partial<HistorySample> = {}): HistorySample => ({
    sampleId: 1000 - minutesAgo,
    observedAt: ago(minutesAgo * 60_000),
    sampledAt: ago(minutesAgo * 60_000),
    generation: 4,
    cpuUtilization: cpu,
    memoryUsedBytes: 2 * 1024 ** 3,
    memoryTotalBytes: 8 * 1024 ** 3,
    filesystemUsedBytes: null,
    filesystemTotalBytes: null,
    ...over,
  });

  // The window is the caller's, not the data's: two samples in the last minute of an hour-long
  // window must draw at the right-hand edge, not stretch across the whole axis as though they
  // covered the hour. Every case below therefore states the window it is drawn in.
  const hourWindow = (): SeriesWindow => ({ fromMs: NOW - 3600_000, toMs: NOW });

  it('breaks the line at a gap instead of drawing through it', () => {
    // The whole reason this page draws its own chart: a library would interpolate across the
    // hole, and a line that crosses a 45-minute silence asserts readings nobody took.
    //
    // Two pairs 5 minutes apart internally, 45 minutes apart across the middle. The tolerance
    // is 10 minutes, so the pairs join and the middle does not: 2 segments, 1 gap. (With the
    // 1-minute raw tolerance every one of these samples is its own island, which is also
    // correct behaviour but asserts nothing about joining.)
    const series = buildSeries(
      [sample(60, 0.3), sample(55, 0.35), sample(10, 0.4), sample(5, 0.45)],
      'cpu',
      hourWindow(),
      10 * 60_000,
    );
    expect(series.segments).toHaveLength(2);
    expect(series.segments[0]).toHaveLength(2);
    expect(series.segments[1]).toHaveLength(2);
    expect(series.gaps).toBe(1);
  });

  it('breaks on a missing value rather than plotting it at zero', () => {
    // 1-minute spacing is inside the 1h window's gap tolerance, so the only thing that can
    // split this run is the absent reading itself.
    const series = buildSeries([sample(4, 0.3), sample(3, null), sample(2, 0.4)], 'cpu', hourWindow(), maxGapFor(1));
    expect(series.segments).toHaveLength(2);
    expect(series.plotted).toBe(2);
    expect(series.missing).toBe(1);
    // Neither segment may carry a zero: that is the defect this whole module exists to prevent.
    expect(series.segments.flat().map((point) => point.value)).toEqual([0.3, 0.4]);
  });

  it('breaks when the node restarted, because two generations are not one trend', () => {
    const series = buildSeries([
      sample(4, 0.3, { generation: 4 }),
      sample(3, 0.35, { generation: 4 }),
      sample(2, 0.2, { generation: 5 }),
      sample(1, 0.25, { generation: 5 }),
    ], 'cpu', hourWindow(), maxGapFor(1));
    expect(series.segments).toHaveLength(2);
    expect(series.gaps).toBe(1);
  });

  it('reports an all-missing window as having nothing to draw, not a flat floor', () => {
    const series = buildSeries([sample(3, null), sample(2, null)], 'cpu', hourWindow(), maxGapFor(1));
    expect(series.segments).toHaveLength(0);
    expect(series.plotted).toBe(0);
    expect(series.missing).toBe(2);
    expect(series.peak).toBeNull();
    expect(series.newest).toBeNull();
  });

  it('orders oldest-first and places each point by its own time in the window', () => {
    const series = buildSeries([sample(1, 0.5), sample(30, 0.1)], 'cpu', hourWindow(), maxGapFor(24));
    const points = series.segments.flat();
    expect(points.map((point) => point.value)).toEqual([0.1, 0.5]);
    // x is the position in the caller's window: 30 minutes into an hour is the middle, and the
    // newest sample sits very near the right edge.
    expect(points[0].x).toBeCloseTo(0.5, 2);
    expect(points[1].x).toBeCloseTo(0.983, 2);
    expect(series.newest?.value).toBe(0.5);
    expect(series.peak?.value).toBe(0.5);
  });

  it('handles a single point, which has no line but is still an observation', () => {
    const series = buildSeries([sample(2, 0.5)], 'cpu', hourWindow(), maxGapFor(1));
    expect(series.plotted).toBe(1);
    expect(series.segments).toHaveLength(1);
    expect(series.gaps).toBe(0);
  });

  it('is empty, not throwing, for no samples at all', () => {
    const series = buildSeries([], 'cpu', hourWindow(), maxGapFor(1));
    expect(series.plotted).toBe(0);
    expect(series.segments).toHaveLength(0);
  });

  it('ignores a sample whose timestamp a clock cannot read', () => {
    const series = buildSeries([sample(2, 0.5, { observedAt: 'not-a-date' })], 'cpu', hourWindow(), maxGapFor(1));
    expect(series.plotted).toBe(0);
    expect(series.missing).toBe(0);
  });
});

describe('segmentPath', () => {
  it('maps a ratio to the plot box with 0 at the bottom', () => {
    const path = segmentPath([
      { x: 0, y: 0, at: 'a', value: 0 },
      { x: 1, y: 1, at: 'b', value: 1 },
    ], 100, 80);
    // y is inverted: a full reading is at the TOP of the box, an empty one on the floor.
    expect(path).toBe('M0.00,80.00 L100.00,0.00');
  });

  it('renders one point as a move with no line, which the caller dots', () => {
    expect(segmentPath([{ x: 0.5, y: 0.5, at: 'a', value: 0.5 }], 100, 80)).toBe('M50.00,40.00');
  });
});

describe('window sizing', () => {
  it('widens the gap tolerance with the window, so an hourly roll-up is not all gaps', () => {
    expect(maxGapFor(1)).toBeLessThan(maxGapFor(24));
    expect(resolutionFor(1)).toBe('raw');
    expect(resolutionFor(24)).toBe('hour');
  });
});

describe('foldEvents', () => {
  const event = (over: Partial<AuditEvent> = {}): AuditEvent => ({
    id: 'e1',
    eventType: 'node.observe',
    actorType: 'node',
    actorId: 'node-a',
    subjectType: 'node',
    subjectId: 'node-a',
    action: 'node.observe',
    result: 'SUCCESS',
    details: {},
    occurredAt: ago(1_000),
    ...over,
  });

  it('folds a run of three identical rows into one, keeping the span', () => {
    const runs = foldEvents([
      event({ id: '1', occurredAt: ago(1_000) }),
      event({ id: '2', occurredAt: ago(2_000) }),
      event({ id: '3', occurredAt: ago(3_000) }),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].count).toBe(3);
    expect(runs[0].firstAt).not.toBe(runs[0].lastAt);
  });

  it('leaves a pair alone, because two actions can be two real events', () => {
    const runs = foldEvents([event({ id: '1' }), event({ id: '2' })]);
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.count === 1)).toBe(true);
  });

  it('does not fold across a different event', () => {
    const runs = foldEvents([
      event({ id: '1' }),
      event({ id: '2' }),
      event({ id: 'x', eventType: 'node.enrolled', action: 'node.enroll' }),
      event({ id: '3' }),
    ]);
    expect(runs).toHaveLength(4);
  });

  it('is empty for no events', () => {
    expect(foldEvents([])).toEqual([]);
  });
});
