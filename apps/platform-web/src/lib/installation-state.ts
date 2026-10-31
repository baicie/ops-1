import type { MessageKey } from '../i18n';
import type { StatusTone } from '../components/status-tone';

/**
 * The one answer to "what is this plugin's installation state", for every surface that shows it.
 *
 * Before this file the answer depended on the page you were looking at: the plugin list drew a
 * chip from `PluginSummary.state` while the detail page drew its headline from the same field but
 * its "deployment status" from `DeploymentView.status` - a different endpoint with a different
 * vocabulary. Two derivations from one fact is not a rendering bug you can fix in either page;
 * it is a missing shared truth, and the next page added would have invented a third.
 *
 * Two rules make the word identical everywhere, by construction rather than by discipline:
 *
 *   1. The word is derived from ONE field: the install state code. Nothing else may change it.
 *      Replica readiness is a separate fact with a separate renderer (`readinessOf`), so a
 *      half-ready deployment can never spin the status word into a different vocabulary.
 *   2. When that field is absent or unmapped the result is `noData` plus the name of what is
 *      missing. A guess dressed as a state is worse than an stated gap (docs/09 §9.1).
 *
 * A wire code never leaves this module as copy: callers get a `kind`, and `components/app/status`
 * is the only thing that turns a kind into pixels.
 */

/** Closed vocabulary. A new state is added here and immediately fails to compile everywhere. */
export type InstallationKind =
  | 'active'
  | 'installed'
  | 'staged'
  | 'failed'
  | 'degraded'
  | 'disabled'
  | 'notInstalled'
  | 'noData';

/** The fields either endpoint may supply. Absent is different from zero. */
export type InstallationInput = {
  /** `PluginSummary.state` / `PluginDetail.state` - the install state code. */
  state?: string | null;
};

export type InstallationState = {
  kind: InstallationKind;
  /** Field names the derivation needed and did not get; empty when the kind is decisive. */
  missing: string[];
  /** The code the input carried, unmodified, for a tooltip or a data attribute. Never copy. */
  code?: string;
};

/**
 * Wire code -> kind. The map is deliberately small: it lists the codes the kernel's install
 * state machine actually emits. Anything else is reported as noData with the missing field
 * named, rather than being rendered as a plausible-looking status.
 */
const KIND_BY_CODE: Record<string, InstallationKind> = {
  ACTIVE: 'active',
  INSTALLED: 'installed',
  STAGED: 'staged',
  FAILED: 'failed',
  REJECTED: 'failed',
  DEGRADED: 'degraded',
  DISABLED: 'disabled',
  UNINSTALLED: 'notInstalled',
  AVAILABLE: 'notInstalled',
};

/** Paint for a kind. Colour is never the only signal - see `GLYPH_BY_KIND`. */
export const TONE_BY_KIND: Record<InstallationKind, StatusTone> = {
  active: 'ok',
  installed: 'ok',
  staged: 'warn',
  failed: 'danger',
  degraded: 'warn',
  disabled: 'neutral',
  notInstalled: 'neutral',
  noData: 'unknown',
};

/**
 * One glyph per kind, distinct within every pair that shares a tone. `active` and `installed`
 * are both green, so they are checked and boxed rather than both ticked: a tick that means
 * "running" and a tick that means "present on disk" are the same colour and must not be the
 * same shape.
 */
export const GLYPH_BY_KIND: Record<InstallationKind, string> = {
  active: 'check',
  installed: 'box',
  staged: 'clock',
  failed: 'warning',
  degraded: 'alert',
  disabled: 'pause',
  notInstalled: 'circleDashed',
  noData: 'rotate',
};

/**
 * Copy for a kind. These are the per-code keys from the catalog, reused rather than cloned, so
 * the vocabulary has exactly one wording per state in both locales.
 */
export const LABEL_KEY_BY_KIND: Record<InstallationKind, MessageKey> = {
  active: 'status.active',
  installed: 'status.installed',
  staged: 'status.staged',
  failed: 'status.failed',
  degraded: 'status.degraded',
  disabled: 'status.disabled',
  notInstalled: 'status.uninstalled',
  noData: 'state.noData',
};

/**
 * Alias kept so a reader (and the test) can name the table by what it is. One object, two
 * names - not two tables.
 */
export const KIND_LABEL_KEYS = LABEL_KEY_BY_KIND;

/**
 * Derive the installation state from the install state code.
 *
 * A blank field is `noData` naming `state`; an unmapped code is `noData` naming it too, because
 * an unknown code is a gap in this module's table, not a fact about the plugin.
 */
export function deriveInstallationState(input: InstallationInput): InstallationState {
  const raw = typeof input.state === 'string' ? input.state.trim() : '';
  if (!raw) return { kind: 'noData', missing: ['state'] };
  const code = raw.toUpperCase();
  const kind = KIND_BY_CODE[code];
  return kind ? { kind, code, missing: [] } : { kind: 'noData', missing: ['state (unmapped code)'], code };
}

/**
 * The observational state each kind paints as. The chip on the plugin list is a
 * `.status-indicator`, and it must speak the same word as the badge on the detail page; this
 * is the bridge, kept beside the vocabulary instead of inside either page.
 */
export const INDICATOR_STATE_BY_KIND: Record<InstallationKind, string> = {
  active: 'ready',
  installed: 'ready',
  staged: 'attention',
  failed: 'error',
  degraded: 'degraded',
  disabled: 'notConfigured',
  notInstalled: 'notConfigured',
  noData: 'unknown',
};

/**
 * Replica readiness, kept out of the status word on purpose.
 *
 * Both endpoints publish `readyInstances`/`totalInstances`; printing them beside the state
 * instead of folding them into it is what stops "STAGED" and "1/1 ready" from being two
 * competing verdicts on one screen - the state answers "what is it", the ratio answers "how
 * many are up", and only one of them may be a word.
 */
export function readinessOf(ready?: number | null, total?: number | null): { ready: number; total: number } | null {
  if (typeof ready !== 'number' || typeof total !== 'number') return null;
  if (Number.isNaN(ready) || Number.isNaN(total)) return null;
  return { ready, total };
}
