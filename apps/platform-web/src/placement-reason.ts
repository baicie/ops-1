import type { MessageKey, TranslateParams } from './i18n';

/**
 * A refused placement reaches the Web shell as one English sentence built by
 * `placement_failure_reason` in `apps/kernel/src/deployments.rs`:
 *
 *   No eligible healthy node matches the placement selector [CPU_INSUFFICIENT] node staging-node:
 *   requested 1000m of CPU but only 900m of 1 cores are budgetable (90% headroom)
 *
 * AGENTS.md forbids rendering that sentence: the bracketed code is the contract and the
 * catalog owns the copy. Parsing is best-effort by design — anything the shell does not
 * recognize is returned verbatim so no server detail is ever dropped.
 */

/** Stable codes emitted by the kernel; the spelling must not change once published. */
export const PLACEMENT_REASON_CODES = [
  'NODE_NOT_READY',
  'SELECTOR_MISMATCH',
  'RESOURCE_SNAPSHOT_MISSING',
  'MEMORY_INSUFFICIENT',
  'CPU_INSUFFICIENT',
  'INSTANCE_CAPACITY_EXCEEDED',
] as const;

export type PlacementReasonCode = (typeof PLACEMENT_REASON_CODES)[number];

/** The `t` from `useT()`, passed in so this module stays free of React. */
export type PlacementTranslate = (key: MessageKey, params?: TranslateParams) => string;

export interface PlacementReason {
  code: PlacementReasonCode;
  /** Node whose placement was refused. */
  node: string;
  /** Kernel wording after the node name, kept verbatim for troubleshooting. */
  detail: string;
  /** Numbers and labels recovered from `detail`; empty when the wording changed shape. */
  values: TranslateParams;
  /** Catalog key of the title chosen for the recovered shape. */
  titleKey: MessageKey;
}

interface ShapeMatch {
  key: MessageKey;
  values: TranslateParams;
}

type ShapeReader = (detail: string) => ShapeMatch | null;

/** `[CODE] node <name>: <detail>`, tolerating any wording the kernel puts in front of it. */
const ENVELOPE = /\[([A-Z][A-Z0-9_]*)\]\s+node\s+(\S+?):\s*([\s\S]*)$/;

/** Used when the code is known but the detail wording is not: still localized, never English. */
const GENERIC_TITLE: Record<PlacementReasonCode, MessageKey> = {
  NODE_NOT_READY: 'placement.reason.nodeNotReady.generic',
  SELECTOR_MISMATCH: 'placement.reason.selectorMismatch.generic',
  RESOURCE_SNAPSHOT_MISSING: 'placement.reason.resourceSnapshotMissing.generic',
  MEMORY_INSUFFICIENT: 'placement.reason.memoryInsufficient.generic',
  CPU_INSUFFICIENT: 'placement.reason.cpuInsufficient.generic',
  INSTANCE_CAPACITY_EXCEEDED: 'placement.reason.instanceCapacityExceeded.generic',
};

/** Kernel scope tokens, localized so zh-CN copy does not leak them. */
const SCOPE_TITLE: Record<string, MessageKey> = {
  'per-node': 'placement.reason.scope.perNode',
  'per-deployment': 'placement.reason.scope.perDeployment',
};

function isCode(value: string): value is PlacementReasonCode {
  return (PLACEMENT_REASON_CODES as readonly string[]).includes(value);
}

function selectorKeyMatches(selector: string, label: string): boolean {
  return selector === label;
}

const shapeReaders: Record<PlacementReasonCode, ShapeReader> = {
  NODE_NOT_READY: (detail) => {
    const matched = /^node status is (.+?), placement requires READY with a recent heartbeat$/.exec(detail);
    return matched ? { key: 'placement.reason.nodeNotReady', values: { status: matched[1] } } : null;
  },

  SELECTOR_MISMATCH: (detail): ShapeMatch | null => {
    const mismatched = /^selector (\S+?)=(.+?) does not match node label (\S+?)=(.+)$/.exec(detail);
    if (mismatched && selectorKeyMatches(mismatched[1], mismatched[3])) {
      return {
        key: 'placement.reason.selectorMismatch',
        values: { key: mismatched[1], expected: mismatched[2], actual: mismatched[4] },
      };
    }
    const missing = /^selector (\S+?)=(.+?) does not match: node has no label (\S+)$/.exec(detail);
    if (missing && selectorKeyMatches(missing[1], missing[3])) {
      return { key: 'placement.reason.selectorMismatch.missingLabel', values: { key: missing[1], expected: missing[2] } };
    }
    return null;
  },

  RESOURCE_SNAPSHOT_MISSING: (detail): ShapeMatch | null => {
    if (/^node has not reported a resource snapshot$/.test(detail)) {
      return { key: 'placement.reason.resourceSnapshotMissing.noSnapshot', values: {} };
    }
    const missingField = /^resource snapshot has no (\S+)$/.exec(detail);
    return missingField ? { key: 'placement.reason.resourceSnapshotMissing', values: { field: missingField[1] } } : null;
  },

  MEMORY_INSUFFICIENT: (detail) => {
    const matched = /^requested (\d+) MiB but only (\d+) MiB of the (\d+) MiB available are budgetable/.exec(detail);
    return matched
      ? { key: 'placement.reason.memoryInsufficient', values: { requested: matched[1], budgetable: matched[2], available: matched[3] } }
      : null;
  },

  CPU_INSUFFICIENT: (detail) => {
    const matched = /^requested (\d+)m of CPU but only (\d+)m of (\d+) cores are budgetable/.exec(detail);
    return matched
      ? { key: 'placement.reason.cpuInsufficient', values: { requested: matched[1], budgetable: matched[2], cores: matched[3] } }
      : null;
  },

  INSTANCE_CAPACITY_EXCEEDED: (detail) => {
    const matched = /^(\d+) instances already scheduled on this node against a (\S+) limit of (\d+)$/.exec(detail);
    return matched
      ? { key: 'placement.reason.instanceCapacityExceeded', values: { instances: matched[1], scope: matched[2], limit: matched[3] } }
      : null;
  },
};

/**
 * Splits a `statusReason` into its stable code, node and detail. Returns `null` for
 * anything without a known code so the caller can show the kernel sentence unchanged.
 */
export function parsePlacementReason(reason: string | null | undefined): PlacementReason | null {
  if (!reason) return null;
  const envelope = ENVELOPE.exec(reason);
  if (!envelope) return null;
  const code = envelope[1];
  if (!isCode(code)) return null;
  const detail = envelope[3].trim();
  const shape = shapeReaders[code](detail);
  return {
    code,
    node: envelope[2],
    detail,
    values: shape?.values ?? {},
    titleKey: shape?.key ?? GENERIC_TITLE[code],
  };
}

export interface PlacementReasonDisplay {
  /** Localized title; the kernel sentence itself when the code is unknown. */
  title: string;
  /** The kernel sentence, present only when `title` is localized, so nothing is lost. */
  raw: string | null;
}

/**
 * What a status reason should render as: a localized title plus the untouched
 * server sentence, or the sentence alone when it carries no known code.
 */
export function describePlacementReason(reason: string | null | undefined, t: PlacementTranslate): PlacementReasonDisplay | null {
  const original = (reason ?? '').trim();
  if (!original) return null;
  const parsed = parsePlacementReason(original);
  if (!parsed) return { title: original, raw: null };
  const values: TranslateParams = { ...parsed.values, node: parsed.node };
  const scope = values.scope;
  if (typeof scope === 'string' && scope in SCOPE_TITLE) values.scope = t(SCOPE_TITLE[scope]);
  return { title: t(parsed.titleKey, values), raw: original };
}
