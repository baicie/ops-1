import type { MessageKey } from '../i18n';
import { ApiError } from '../api';

/**
 * The Kernel's operator sentences are English, and the wire payload carries no message code
 * for them yet (`AttentionItem { title, detail }` in apps/kernel/src/plugins.rs is free text).
 * AGENTS.md forbids handing a server sentence to the user, so this module owns the closed
 * mapping the client is allowed to make: an exact Kernel sentence maps to a catalog key, and
 * anything the table does not know is shown **verbatim with its source marked**, which is the
 * only honest option while the contract has no code to branch on.
 *
 * Adding a Kernel sentence here is the only way it can become localized copy; a changed
 * Kernel sentence falls back to the raw text instead of silently rendering stale copy.
 */

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

export interface ServerText {
  text: string;
  /** `catalog` = recognized and localized; `kernel` = raw server sentence, source shown. */
  source: 'catalog' | 'kernel';
}

interface SentenceRule {
  /** The Kernel sentence, anchored, with its variable parts captured in order. */
  pattern: RegExp;
  key: MessageKey;
  /** Capture names, in order, passed to the message. */
  names: readonly string[];
}

/** Titles the Kernel can put in `Overview.attention[]` (apps/kernel/src/plugins.rs). */
const TITLE_RULES: readonly SentenceRule[] = [
  { pattern: /^No nodes enrolled$/, key: 'kernel.attention.noNodes.title', names: [] },
  { pattern: /^Node (.+) was revoked$/, key: 'kernel.attention.nodeRevoked.title', names: ['node'] },
  { pattern: /^Node (.+) heartbeat is stale$/, key: 'kernel.attention.nodeStale.title', names: ['node'] },
  { pattern: /^Active plugin (.+) has a revoked publisher$/, key: 'kernel.attention.revokedPublisher.title', names: ['plugin'] },
  { pattern: /^Deployment (.+) is ([A-Z_]+)$/, key: 'kernel.attention.deployment.title', names: ['deployment', 'status'] },
];

/** Details the same rows can carry. */
const DETAIL_RULES: readonly SentenceRule[] = [
  {
    pattern: /^Create an enrollment token and join a Linux node\.? before deploying plugins\.$/,
    key: 'kernel.attention.noNodes.detail',
    names: [],
  },
  {
    pattern: /^Publisher (.+) is revoked\. Gateway, assets and extensions now fail closed; activate a trusted replacement or disable the plugin\.$/,
    key: 'kernel.attention.revokedPublisher.detail',
    names: ['publisher'],
  },
  {
    pattern: /^Node (.+) has not sent a heartbeat for longer than the stale threshold\.?$/,
    key: 'kernel.attention.nodeStale.detail',
    names: ['node'],
  },
];

function applyRule(rules: readonly SentenceRule[], value: string, t: Translate): ServerText {
  for (const rule of rules) {
    const match = rule.pattern.exec(value);
    if (!match) continue;
    const params: Record<string, string> = {};
    rule.names.forEach((name, index) => { params[name] = match[index + 1] ?? ''; });
    return { text: t(rule.key, params), source: 'catalog' };
  }
  return { text: value, source: 'kernel' };
}

export function localizeAttentionTitle(value: string, t: Translate): ServerText {
  return applyRule(TITLE_RULES, value, t);
}

export function localizeAttentionDetail(value: string, t: Translate): ServerText {
  return applyRule(DETAIL_RULES, value, t);
}

/**
 * An HTTP failure explained by its status class, plus the Kernel's own sentence kept aside as
 * attributed text. The status is a protocol fact the client can read without guessing; the
 * message is not.
 */
export interface ApiFailureCopy {
  reason: string;
  /** The Kernel sentence, or null when the failure never reached the Kernel. */
  kernelMessage: string | null;
}

export function apiFailureCopy(error: Error | null, t: Translate): ApiFailureCopy {
  const apiError = error instanceof ApiError ? error : null;
  const status = apiError?.status ?? 0;
  const key: MessageKey =
    status === 401 ? 'ui.error.sessionExpired'
      : status === 404 ? 'ui.error.missing'
        : status === 409 ? 'ui.error.conflict'
          : status === 429 ? 'ui.error.rateLimited'
            : status === 0 ? 'ui.error.unreachable'
              : status >= 500 ? 'ui.error.serverFault'
                : 'ui.error.rejected';
  return { reason: t(key), kernelMessage: apiError?.message || (error && !apiError ? error.message : null) };
}
