import * as React from 'react';
import { Icon } from '../Icons';
import { useT } from '../../i18n';
import type { MessageKey } from '../../i18n';
import { cn } from '../../lib/utils';

/**
 * The observational vocabulary of docs/09 §9.1, rendered as colour **plus** glyph **plus**
 * text. Colour alone never carries the meaning: every indicator prints its own label, and the
 * data-indicator attribute keeps the state machine-readable for tests and tooling.
 *
 * A state is never folded into a neighbour to save a colour: "stopped on purpose" (STOPPED)
 * and "never configured" (DISABLED / UNINSTALLED) are different facts about a node.
 */
export type IndicatorState =
  | 'ready'
  | 'degraded'
  | 'attention'
  | 'stale'
  | 'unreachable'
  | 'revoked'
  | 'stopped'
  | 'unknown'
  | 'noData'
  | 'partial'
  | 'loading'
  | 'error'
  | 'forbidden'
  | 'conflict'
  | 'notConfigured';

const LABEL_KEYS: Record<IndicatorState, MessageKey> = {
  ready: 'state.ready',
  degraded: 'state.degraded',
  attention: 'state.attention',
  stale: 'state.stale',
  unreachable: 'state.unreachable',
  revoked: 'state.revoked',
  // The label for a deliberately stopped process already exists in both catalogs as the
  // per-code vocabulary shared with status-tone.ts; reusing it keeps one wording for
  // STOPPED instead of a second copy that could drift.
  stopped: 'status.stopped',
  unknown: 'state.unknown',
  noData: 'state.noData',
  partial: 'state.partial',
  loading: 'state.loading',
  error: 'state.error',
  forbidden: 'state.forbidden',
  conflict: 'state.conflict',
  notConfigured: 'state.notConfigured',
};

/** One glyph per state, distinct within the four node states the spec singles out. */
const GLYPHS: Record<IndicatorState, string> = {
  ready: 'check',
  degraded: 'warning',
  attention: 'alert',
  stale: 'clock',
  unreachable: 'stop',
  revoked: 'key',
  // A square pause, not a stop sign and not a gear: parked is neither broken nor unconfigured.
  stopped: 'pause',
  unknown: 'rotate',
  noData: 'file',
  partial: 'filter',
  loading: 'refresh',
  error: 'warning',
  forbidden: 'access',
  conflict: 'copy',
  notConfigured: 'settings',
};

/**
 * Presentation the shared stylesheet has no modifier class for yet, expressed from the same
 * semantic tokens so the palette and the theme still come from one place. A parked process
 * is neither running (`ready` green) nor broken (`error` red): muted text on the sunken
 * surface with a solid outline reads "deliberately not running".
 */
const STATE_STYLES: Partial<Record<IndicatorState, React.CSSProperties>> = {
  stopped: {
    color: 'var(--ow-text-secondary)',
    background: 'var(--ow-surface-3)',
    borderColor: 'var(--ow-border-strong)',
  },
};

/** Wire codes that mean the same observational state; a code outside this map is UNKNOWN. */
const CODE_STATES: Record<string, IndicatorState> = {
  READY: 'ready',
  ACTIVE: 'ready',
  INSTALLED: 'ready',
  CONFIRMED: 'ready',
  PASSED: 'ready',
  ONLINE: 'ready',
  VERIFIED: 'ready',
  DEGRADED: 'degraded',
  UNHEALTHY: 'degraded',
  ATTENTION: 'attention',
  PENDING: 'attention',
  PREPARING: 'attention',
  STARTING: 'attention',
  DRAINING: 'attention',
  STAGED: 'attention',
  UNREACHABLE: 'unreachable',
  FAILED: 'error',
  REJECTED: 'error',
  UNKNOWN: 'unknown',
  // Never configured: there is nothing to observe yet.
  DISABLED: 'notConfigured',
  UNINSTALLED: 'notConfigured',
  // Configured and then stopped on purpose: a fact about the process, not about
  // configuration, and not a healthy one - it must not be read as READY.
  STOPPED: 'stopped',
};

/**
 * Effective state of an observed row.
 *
 * Priority: revocation, then a terminal failure the source already named (UNREACHABLE), then
 * staleness, then the stored code — a node that stopped reporting must never look READY
 * (docs/09 §9.5), and a node the Kernel already calls UNREACHABLE keeps that name.
 */
export function indicatorStateForCode(code?: string | null, flags?: { stale?: boolean; revoked?: boolean }): IndicatorState {
  if (flags?.revoked) return 'revoked';
  if (!code) return flags?.stale ? 'stale' : 'unknown';
  const state = CODE_STATES[code.toUpperCase()] ?? 'unknown';
  if (state === 'unreachable') return state;
  if (flags?.stale) return 'stale';
  return state;
}

export function StatusIndicator({
  state,
  label,
  detail,
  className,
}: {
  state: IndicatorState;
  /** Protocol code rendered verbatim when the mapping does not know it; never localized. */
  label?: string;
  detail?: React.ReactNode;
  className?: string;
}) {
  const t = useT();
  return (
    <span
      className={cn('status-indicator', `status-indicator--${state}`, className)}
      data-indicator={state}
      style={STATE_STYLES[state]}
    >
      <Icon name={GLYPHS[state]} size={12} />
      <span className="status-indicator-label">{label ?? t(LABEL_KEYS[state])}</span>
      {detail ? <span className="status-indicator-detail">{detail}</span> : null}
    </span>
  );
}

/**
 * The literal tokens the spec reserves for "the source cannot answer this": NO_DATA (a source
 * exists, no sample in this window) and UNKNOWN (observation or permission unconfirmed). They
 * are protocol vocabulary, not copy, so they stay verbatim; the localized meaning rides along
 * as the accessible name and tooltip.
 */
export function ValueToken({ token, detail, className }: { token: 'NO_DATA' | 'UNKNOWN'; detail?: string; className?: string }) {
  const t = useT();
  return (
    <span className={cn('value-token', `value-token--${token === 'NO_DATA' ? 'no-data' : 'unknown'}`, className)} data-value={token} title={detail}>
      <span aria-hidden="true">{token}</span>
      <span className="sr-only">{t(token === 'NO_DATA' ? 'state.noData' : 'state.unknown')}</span>
    </span>
  );
}

export function NoData({ detail, className }: { detail?: string; className?: string }) {
  return <ValueToken token="NO_DATA" detail={detail} className={className} />;
}

export function UnknownValue({ detail, className }: { detail?: string; className?: string }) {
  return <ValueToken token="UNKNOWN" detail={detail} className={className} />;
}
