/**
 * One read per resource and version, with no way to lose the answer.
 *
 * The incident this file exists for: the Plugins table marked a plugin as "already asked"
 * *before* the detail request went out, then the 8s list poll replaced the plugins array and
 * the effect that owned the request was cancelled. The response arrived, the cancelled effect
 * threw it away, and the mark still said "asked" - so no later cycle ever asked again and the
 * row printed NO_DATA in the deployment, replica and digest columns while
 * `GET /api/v1/plugins/{id}` had answered 200 with all three values.
 *
 * Three rules make that state impossible:
 *
 *   1. a key is recorded as settled only after the read *resolved* - a failed read is not a
 *      fact, so the next cycle asks again;
 *   2. an in-flight read is adopted, never abandoned: a cycle that takes over the effect joins
 *      the promise already running, so the answer has an owner that can write it;
 *   3. an answer belongs to the resource, not to the effect that asked for it, so a cycle that
 *      has since been replaced may still write what it learned - unless a verb invalidated it
 *      (`forget`) or a newer version of the same resource superseded it.
 *
 * A read that fails resolves to the caller's `missing` value, which is the value that renders
 * NO_DATA. That is deliberate: a source that cannot answer keeps printing NO_DATA, and nothing
 * here turns an absence into a number.
 */

export interface FactsRead<T> {
  /** The resource the answer describes, e.g. a plugin id. */
  id: string;
  /** The identity of the answer within that resource, e.g. `id@version`. */
  key: string;
  read: () => Promise<T>;
  /** What the caller prints while the source cannot answer. Never a guessed value. */
  missing: T;
}

/** The answer to hand to the caller, or null when it was superseded and must not be shown. */
export interface FactsAnswer<T> {
  id: string;
  value: T;
}

export interface FactsLedger<T> {
  /** True when this key has neither a settled value nor a read in flight. */
  needs(key: string): boolean;
  load(request: FactsRead<T>): Promise<FactsAnswer<T> | null>;
  /** A verb changed the resource: drop what was settled and disown what is in flight. */
  forget(id: string): void;
}

function ownsKey(key: string, id: string): boolean {
  return key.startsWith(`${id}@`);
}

export function createFactsLedger<T>(): FactsLedger<T> {
  const settled = new Map<string, T>();
  const pending = new Map<string, Promise<FactsAnswer<T> | null>>();
  /** The newest key asked for per resource: an older key's late answer is stale, not news. */
  const latest = new Map<string, string>();
  /** Bumped by `forget`, so an answer read before a verb cannot land after it. */
  const generations = new Map<string, number>();

  function generationOf(id: string): number {
    return generations.get(id) ?? 0;
  }

  function load({ id, key, read, missing }: FactsRead<T>): Promise<FactsAnswer<T> | null> {
    const running = pending.get(key);
    if (running) return running;
    if (settled.has(key)) return Promise.resolve({ id, value: settled.get(key) as T });

    const generation = generationOf(id);
    latest.set(id, key);
    const stillCurrent = () => generationOf(id) === generation && latest.get(id) === key;

    const started = read().then(
      (value) => {
        if (!stillCurrent()) return null;
        settled.set(key, value);
        return { id, value };
      },
      // A rejection is not a fact: report the missing value so the row keeps NO_DATA, and leave
      // the key unsettled so the next cycle asks again rather than freezing the row.
      () => (stillCurrent() ? { id, value: missing } : null),
    );
    pending.set(key, started);
    // Only the promise this map still holds may retire itself: a read started after `forget`
    // must not be evicted by an older one settling late.
    void started.then(() => { if (pending.get(key) === started) pending.delete(key); });
    return started;
  }

  return {
    needs(key: string): boolean {
      return !settled.has(key) && !pending.has(key);
    },
    load,
    forget(id: string): void {
      generations.set(id, generationOf(id) + 1);
      latest.delete(id);
      for (const key of [...settled.keys()]) if (ownsKey(key, id)) settled.delete(key);
      for (const key of [...pending.keys()]) if (ownsKey(key, id)) pending.delete(key);
    },
  };
}
