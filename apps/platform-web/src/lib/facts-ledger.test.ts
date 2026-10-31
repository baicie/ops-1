import { describe, expect, it } from 'vitest';
import { createFactsLedger, type FactsAnswer, type FactsLedger } from './facts-ledger';

/**
 * The Plugins table's facts layer, pinned by the incident it exists for.
 *
 * A "cycle" below is one run of the page effect: the list poll hands it a fresh plugins array,
 * it asks the ledger for the rows it does not have, and it writes what comes back. The old code
 * marked a row as asked *before* the request and dropped the answer when the cycle was replaced —
 * so a slow detail route cost that row its deployment, replica and digest columns for good. The
 * assertions here are about the two cycles *after* the first one, which is where the old bug
 * lived: a single green cycle proves nothing.
 */

interface Facts {
  digest: string | null;
  deploymentStatus: string | null;
  deploymentCount: number;
}

const EMPTY: Facts = { digest: null, deploymentStatus: null, deploymentCount: 0 };
const REAL: Facts = { digest: 'sha256:7a06081ff', deploymentStatus: 'DEGRADED', deploymentCount: 1 };

interface Row {
  id: string;
  latestVersion: string;
  facts: Facts;
}

/** The page effect, minus React: ask for what the ledger does not have, write what returns. */
function cycle(
  ledger: FactsLedger<Facts>,
  rows: Row[],
  read: (row: Row) => Promise<Facts>,
): Array<Promise<FactsAnswer<Facts> | null>> {
  const writes: Array<Promise<FactsAnswer<Facts> | null>> = [];
  for (const row of rows) {
    const key = `${row.id}@${row.latestVersion}`;
    if (!ledger.needs(key)) continue;
    writes.push(ledger.load({ id: row.id, key, read: () => read(row), missing: EMPTY }).then((answer) => {
      if (answer) row.facts = answer.value;
      return answer;
    }));
  }
  return writes;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createFactsLedger', () => {
  it('keeps the answer when the cycle that asked for it was replaced by the next poll', async () => {
    const ledger = createFactsLedger<Facts>();
    const row: Row = { id: 'dev.opsweave.hello', latestVersion: '0.0.1', facts: EMPTY };
    let reads = 0;
    // The detail route answers 200 - but later than the 8s list poll, which is the whole trigger.
    let release: (value: Facts) => void = () => {};
    const slow = () => { reads += 1; return new Promise<Facts>((resolve) => { release = resolve; }); };

    cycle(ledger, [row], slow);
    // Poll 1 lands before the response does: this cycle is abandoned exactly like the old effect.
    const secondCycle = cycle(ledger, [row], slow);
    expect(reads).toBe(1); // adopted, not asked twice

    release(REAL);
    await Promise.all([...secondCycle, ...cycle(ledger, [{ ...row }], slow)].map((p) => p ?? Promise.resolve(null)));
    await flush();

    if (row.facts === EMPTY) throw new Error('unreachable'); // narrows the type for the assertions below
    expect(row.facts).toEqual(REAL);
    expect(row.facts.deploymentStatus).not.toBeNull(); // not NO_DATA
    expect(row.facts.digest).not.toBeNull(); // not NO_DATA
    expect(row.facts.deploymentCount).toBe(1); // not NO_DATA
  });

  it('never falls back to NO_DATA on the two poll cycles after the first answer', async () => {
    const ledger = createFactsLedger<Facts>();
    const row: Row = { id: 'dev.opsweave.hello', latestVersion: '0.0.1', facts: EMPTY };
    let reads = 0;
    const read = async () => { reads += 1; return REAL; };

    await Promise.all(cycle(ledger, [row], read));
    expect(row.facts).toEqual(REAL);
    const readsAfterFirstAnswer = reads;

    // Two more polls, each handing the effect a brand-new array - the old bug's kill switch.
    for (const poll of [1, 2]) {
      await Promise.all(cycle(ledger, [row], read));
      await flush();
      expect(row.facts, `poll cycle ${poll + 1}`).toEqual(REAL);
      expect(row.facts.digest, `poll cycle ${poll + 1} digest`).not.toBeNull();
    }
    expect(reads).toBe(readsAfterFirstAnswer); // a settled key is not asked again
  });

  it('keeps NO_DATA when the source genuinely has no facts, and does not invent a value', async () => {
    const ledger = createFactsLedger<Facts>();
    // A built-in plugin with no package version and no deployment: the detail route answers 200
    // with empty arrays, which computes to null facts. Honest NO_DATA, not a fabricated zero.
    const row: Row = { id: 'dev.opsweave.ops-center', latestVersion: '0.0.1', facts: EMPTY };
    let reads = 0;
    const read = async () => { reads += 1; return EMPTY; };

    for (const poll of [1, 2, 3]) {
      await Promise.all(cycle(ledger, [row], read));
      await flush();
      expect(row.facts, `poll cycle ${poll}`).toEqual(EMPTY);
      expect(row.facts.deploymentStatus).toBeNull();
      expect(row.facts.digest).toBeNull();
    }
    expect(reads).toBe(1); // EMPTY is a real answer: it is settled, so the route is asked once
  });

  it('retries a failed read on the next cycle instead of greeting the row with NO_DATA forever', async () => {
    const ledger = createFactsLedger<Facts>();
    const row: Row = { id: 'dev.opsweave.hello', latestVersion: '0.0.1', facts: EMPTY };
    let reads = 0;
    const flaky = async () => { reads += 1; if (reads === 1) throw Object.assign(new Error('gateway timeout'), { status: 504 }); return REAL; };

    await Promise.all(cycle(ledger, [row], flaky));
    await flush();
    // First cycle fails: the row shows NO_DATA, which is true - the source did not answer.
    expect(row.facts).toEqual(EMPTY);

    await Promise.all(cycle(ledger, [row], flaky));
    await flush();
    expect(reads).toBe(2); // a failure is not a fact, so the next poll asks again
    expect(row.facts).toEqual(REAL);
  });

  it('drops an answer that a verb invalidated, and re-reads after it', async () => {
    const ledger = createFactsLedger<Facts>();
    const row: Row = { id: 'dev.opsweave.hello', latestVersion: '0.0.1', facts: EMPTY };
    let reads = 0;
    let release: (value: Facts) => void = () => {};
    const slow = () => { reads += 1; return new Promise<Facts>((resolve) => { release = resolve; }); };

    const first = cycle(ledger, [row], slow)[0];
    // A disable/rollback ran while the read was in flight: its answer describes the pre-verb
    // resource, so it must not be displayed as the post-verb state.
    ledger.forget(row.id);
    release(REAL);
    expect(await first).toBeNull();

    await Promise.all(cycle(ledger, [row], async () => { reads += 1; return EMPTY; }));
    await flush();
    expect(reads).toBe(2);
    expect(row.facts).toEqual(EMPTY);
  });

  it('lets a newer package version replace an answer for the older one, in either order', async () => {
    const ledger = createFactsLedger<Facts>();
    const row: Row = { id: 'dev.opsweave.hello', latestVersion: '0.0.1', facts: EMPTY };
    let releaseOld: (value: Facts) => void = () => {};
    const oldRead = () => new Promise<Facts>((resolve) => { releaseOld = resolve; });

    const stale = cycle(ledger, [row], oldRead)[0];
    // The package was upgraded while that read was in flight; the new key answers first.
    row.latestVersion = '0.0.2';
    await Promise.all(cycle(ledger, [row], async () => REAL));
    releaseOld({ digest: 'sha256:old', deploymentStatus: 'ACTIVE', deploymentCount: 3 });

    // A superseded answer is dropped, not displayed: null means "must not be shown".
    expect(await stale).toBeNull();
    expect(row.facts).toEqual(REAL);
  });
});
