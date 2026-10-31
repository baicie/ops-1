import type { MessageKey } from '../i18n';

/**
 * The one mapping from a wire status code to what the shell paints.
 *
 * Every renderer reads this table: `StatusPill`/pages paint a shadcn Badge from `tone`, and
 * `StatusIndicator` paints a chip from `state`. Keeping both fields in one row is what stops
 * the same code from being blue in a table and green on a card - the drift the v3 audit found
 * between here and `app/status-indicator.tsx`.
 *
 * The code itself is protocol data and is never translated.
 */
export type StatusTone = 'ok' | 'info' | 'neutral' | 'warn' | 'danger' | 'unknown';

/**
 * Observational state a code resolves to (docs/09 §9.1). Only states a **code** can mean are
 * listed: `stale`/`loading`/`error`/`forbidden`/`conflict`/`noData`/`partial` are component
 * states that never arrive as a wire code and live next to the renderer instead.
 */
export type StatusState =
  | 'ready'
  | 'running'
  | 'attention'
  | 'degraded'
  | 'stopped'
  | 'unreachable'
  | 'error'
  | 'unknown'
  | 'notConfigured';

export type StatusEntry = {
  tone: StatusTone;
  state: StatusState;
  labelKey: MessageKey;
  /**
   * Optional per-code glyph. Two codes can share a tone and must still not share a shape: a
   * green tick used to mean both "the box is up" (CONFIRMED) and "we wrote the request down"
   * (ACCEPTED), which is how "we accepted it" and "it actually happened" became one picture.
   */
  glyph?: string;
};

export const STATUS_MAP: Record<string, StatusEntry> = {
  READY: { tone: 'ok', state: 'ready', labelKey: 'status.ready' },
  ACTIVE: { tone: 'ok', state: 'ready', labelKey: 'status.active' },
  INSTALLED: { tone: 'ok', state: 'ready', labelKey: 'status.installed' },
  CONFIRMED: { tone: 'ok', state: 'ready', labelKey: 'status.confirmed' },
  ONLINE: { tone: 'ok', state: 'ready', labelKey: 'status.online' },
  // A deployment that finished is the one thing a console exists to tell you. It used to fall
  // through to UNKNOWN and paint a dashed clock, so "it worked" and "we have no idea" looked
  // identical (v3 audit §2.4.2).
  SUCCEEDED: { tone: 'ok', state: 'ready', labelKey: 'status.succeeded' },
  COMPLETED: { tone: 'ok', state: 'ready', labelKey: 'status.completed' },
  // A request the kernel admitted: the positive counterpart of REJECTED, not a claim that the
  // work finished. It is neutral and drawn as an inbox, never as a green tick - ACCEPTED and
  // CONFIRMED measured identical (bg #e6f6ef / fg #0f8a5f) while meaning different things.
  // `state` stays 'running' because admitted work is in flight, not done.
  ACCEPTED: { tone: 'neutral', state: 'running', labelKey: 'status.accepted', glyph: 'inbox' },
  VERIFIED: { tone: 'ok', state: 'ready', labelKey: 'status.verified' },
  RUNNING: { tone: 'info', state: 'running', labelKey: 'status.running' },
  CLAIMED: { tone: 'info', state: 'running', labelKey: 'status.claimed' },
  // Waiting for a runner is the same fact PENDING names, so it keeps PENDING's attention chip
  // instead of inventing a ninth colour for "not started yet".
  QUEUED: { tone: 'warn', state: 'attention', labelKey: 'status.queued' },
  STAGED: { tone: 'warn', state: 'attention', labelKey: 'status.staged' },
  AVAILABLE: { tone: 'neutral', state: 'notConfigured', labelKey: 'status.available' },
  DISABLED: { tone: 'neutral', state: 'notConfigured', labelKey: 'status.disabled' },
  UNINSTALLED: { tone: 'neutral', state: 'notConfigured', labelKey: 'status.uninstalled' },
  // Deliberately stopped, not broken: the same reasoning the indicator already applies to STOPPED.
  STOPPED: { tone: 'neutral', state: 'stopped', labelKey: 'status.stopped' },
  CANCELLED: { tone: 'neutral', state: 'stopped', labelKey: 'status.cancelled' },
  PENDING: { tone: 'warn', state: 'attention', labelKey: 'status.pending' },
  PREPARING: { tone: 'warn', state: 'attention', labelKey: 'status.preparing' },
  STARTING: { tone: 'warn', state: 'attention', labelKey: 'status.starting' },
  DRAINING: { tone: 'warn', state: 'attention', labelKey: 'status.draining' },
  DEGRADED: { tone: 'warn', state: 'degraded', labelKey: 'status.degraded' },
  ATTENTION: { tone: 'warn', state: 'attention', labelKey: 'status.attention' },
  UNHEALTHY: { tone: 'danger', state: 'degraded', labelKey: 'status.unhealthy' },
  FAILED: { tone: 'danger', state: 'error', labelKey: 'status.failed' },
  REJECTED: { tone: 'danger', state: 'error', labelKey: 'status.rejected' },
  UNREACHABLE: { tone: 'danger', state: 'unreachable', labelKey: 'status.unreachable' },
  // Quality runs are emitted by the data-catalog plugin, not by the kernel, so this code
  // arrives as data. It is the one extra state the Governance page actually renders; any
  // further plugin-defined code still degrades to the raw value in a dashed pill.
  PASSED: { tone: 'ok', state: 'ready', labelKey: 'status.passed' },
  // G11 incident slice. Three closed sets, one table: an incident lifecycle, an impact scale, and
  // a human verdict. No code appears in two sets, so one entry per code stays unambiguous.
  // OPEN is 'attention' because nobody has started; INVESTIGATING is the counterpart of RUNNING.
  OPEN: { tone: 'warn', state: 'attention', labelKey: 'status.open' },
  INVESTIGATING: { tone: 'info', state: 'running', labelKey: 'status.investigating' },
  // A concluded incident carries a signature, not a healthy system: green is reserved for the
  // verdict itself, and the lifecycle chip stays neutral so "someone judged this" cannot read as
  // "this is fine".
  CONCLUDED: { tone: 'neutral', state: 'stopped', labelKey: 'status.concluded', glyph: 'check' },
  CLOSED: { tone: 'neutral', state: 'stopped', labelKey: 'status.closed' },
  CRITICAL: { tone: 'danger', state: 'attention', labelKey: 'status.critical' },
  MAJOR: { tone: 'warn', state: 'attention', labelKey: 'status.major' },
  MINOR: { tone: 'info', state: 'attention', labelKey: 'status.minor' },
  WARNING: { tone: 'neutral', state: 'attention', labelKey: 'status.warning' },
  REFUTED: { tone: 'danger', state: 'error', labelKey: 'status.refuted' },
  // UNKNOWN is already taken by "we do not know"; an inconclusive verdict is a *decision* that
  // the evidence did not settle the question, so it gets its own neutral chip and its own word.
  INCONCLUSIVE: { tone: 'neutral', state: 'unknown', labelKey: 'status.inconclusive', glyph: 'rotate' },
  UNKNOWN: { tone: 'unknown', state: 'unknown', labelKey: 'status.unknown' },
};

/** Lookup that never throws on a code the mapping has not seen yet. */
export function statusForCode(code?: string | null): StatusEntry | undefined {
  if (!code) return undefined;
  return STATUS_MAP[code.toUpperCase()];
}

/**
 * `StatusBadge` glyph for a tone. Colour never carries the meaning alone: every tone has its
 * own glyph, and UNKNOWN is the only one that draws a question-like arrow next to a dashed
 * border, so "success" and "unknown" separate in shape as well as in hue.
 */
export function glyphForTone(tone: StatusTone): string {
  if (tone === 'ok') return 'check';
  if (tone === 'info') return 'refresh';
  if (tone === 'warn') return 'alert';
  if (tone === 'danger') return 'warning';
  if (tone === 'neutral') return 'pause';
  return 'rotate';
}

/**
 * The glyph an entry paints: its own when the code needs to differ from its tone-mates,
 * otherwise the tone's glyph.
 */
export function glyphForEntry(entry: StatusEntry): string {
  return entry.glyph ?? glyphForTone(entry.tone);
}

/** shadcn `Badge` variant for a tone. */
export function badgeVariantForTone(tone: StatusTone): 'success' | 'info' | 'secondary' | 'warning' | 'destructive' {
  if (tone === 'ok') return 'success';
  if (tone === 'info') return 'info';
  if (tone === 'warn') return 'warning';
  if (tone === 'danger') return 'destructive';
  return 'secondary';
}
