import type { MessageKey } from '../i18n';

/**
 * One mapping for every status code the shell renders, keyed by the wire value.
 *
 * The tone is the only thing a component needs: each renderer derives its own
 * presentation from it (StatusBadge paints a .status pill, pages paint a shadcn Badge),
 * so the contract cannot drift into two copies that disagree about what DEGRADED means.
 * The code itself is protocol data and is never translated.
 */
export type StatusTone = 'ok' | 'info' | 'neutral' | 'warn' | 'danger' | 'unknown';

export type StatusEntry = { tone: StatusTone; labelKey: MessageKey };

export const STATUS_MAP: Record<string, StatusEntry> = {
  READY: { tone: 'ok', labelKey: 'status.ready' },
  ACTIVE: { tone: 'ok', labelKey: 'status.active' },
  INSTALLED: { tone: 'ok', labelKey: 'status.installed' },
  CONFIRMED: { tone: 'ok', labelKey: 'status.confirmed' },
  ONLINE: { tone: 'ok', labelKey: 'status.online' },
  STAGED: { tone: 'info', labelKey: 'status.staged' },
  VERIFIED: { tone: 'info', labelKey: 'status.verified' },
  AVAILABLE: { tone: 'neutral', labelKey: 'status.available' },
  DISABLED: { tone: 'neutral', labelKey: 'status.disabled' },
  UNINSTALLED: { tone: 'neutral', labelKey: 'status.uninstalled' },
  STOPPED: { tone: 'neutral', labelKey: 'status.stopped' },
  PENDING: { tone: 'warn', labelKey: 'status.pending' },
  PREPARING: { tone: 'warn', labelKey: 'status.preparing' },
  STARTING: { tone: 'warn', labelKey: 'status.starting' },
  DRAINING: { tone: 'warn', labelKey: 'status.draining' },
  DEGRADED: { tone: 'warn', labelKey: 'status.degraded' },
  ATTENTION: { tone: 'warn', labelKey: 'status.attention' },
  UNHEALTHY: { tone: 'danger', labelKey: 'status.unhealthy' },
  FAILED: { tone: 'danger', labelKey: 'status.failed' },
  REJECTED: { tone: 'danger', labelKey: 'status.rejected' },
  UNREACHABLE: { tone: 'danger', labelKey: 'status.unreachable' },
  // Quality runs are emitted by the data-catalog plugin, not by the kernel, so this code
  // arrives as data. It is the one extra state the Governance page actually renders; any
  // further plugin-defined code still degrades to the raw value in a dashed pill.
  PASSED: { tone: 'ok', labelKey: 'status.passed' },
  UNKNOWN: { tone: 'unknown', labelKey: 'status.unknown' },
};

/** `StatusBadge` glyph for a tone. */
export function glyphForTone(tone: StatusTone): string {
  if (tone === 'ok') return 'check';
  if (tone === 'danger') return 'warning';
  if (tone === 'warn') return 'alert';
  return 'clock';
}

/** shadcn `Badge` variant for a tone. */
export function badgeVariantForTone(tone: StatusTone): 'success' | 'info' | 'secondary' | 'warning' | 'destructive' {
  if (tone === 'ok') return 'success';
  if (tone === 'info') return 'info';
  if (tone === 'warn') return 'warning';
  if (tone === 'danger') return 'destructive';
  return 'secondary';
}
