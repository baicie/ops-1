import * as React from 'react';
import { Badge } from '../ui/badge';
import { Icon } from '../Icons';
import { useT } from '../../i18n';
import { cn } from '../../lib/utils';
import { badgeVariantForTone, glyphForEntry, statusForCode } from '../status-tone';
import {
  GLYPH_BY_KIND,
  LABEL_KEY_BY_KIND,
  TONE_BY_KIND,
  deriveInstallationState,
  type InstallationKind,
} from '../../lib/installation-state';

/**
 * The single status renderer. Every chip on every surface is this component.
 *
 * It exists because the same enum used to be spelled six ways - `Ready` in one column, `STAGED`
 * in a toast, `Installed` on a card, `INSTALLED` in the key/value grid beside it - and two
 * different codes (`ACCEPTED`, `CONFIRMED`) painted the identical green because the tone table
 * gave both of them `ok`.
 *
 * Two ways in, one way out:
 *   - `kind`: an `InstallationKind`, resolved through the shared derivation's tables.
 *   - `code`: a raw wire code, resolved through `status-tone` so nothing here re-invents one.
 *
 * A wire code is never rendered as text. It rides along in `data-status` for tests and tooling,
 * and what the reader sees is catalog copy in their own language.
 */
export function Status({
  kind,
  code,
  detail,
  className,
}: {
  kind?: InstallationKind;
  code?: string | null;
  /** Extra context for the tooltip; never rendered as the label. */
  detail?: string;
  className?: string;
}) {
  const t = useT();

  const resolved = React.useMemo(() => {
    if (kind) {
      return {
        variant: badgeVariantForTone(TONE_BY_KIND[kind]),
        glyph: GLYPH_BY_KIND[kind],
        text: t(LABEL_KEY_BY_KIND[kind]),
        dataStatus: undefined as string | undefined,
        unmapped: false,
      };
    }
    const normalized = code ? code.trim().toUpperCase() : '';
    const entry = statusForCode(normalized);
    if (entry) {
      return {
        variant: badgeVariantForTone(entry.tone),
        glyph: glyphForEntry(entry),
        text: t(entry.labelKey),
        dataStatus: normalized,
        unmapped: false,
      };
    }
    // An unmapped code is a gap in the shared table, not a status: say "Unknown" and keep the
    // raw value in a tooltip and a data attribute instead of printing protocol at the reader.
    return {
      variant: badgeVariantForTone('unknown'),
      glyph: 'rotate',
      text: t('status.unknown'),
      dataStatus: normalized || undefined,
      unmapped: true,
    };
  }, [kind, code, t]);

  return (
    <Badge
      variant={resolved.variant}
      data-status={resolved.dataStatus}
      data-kind={kind}
      title={detail ?? resolved.dataStatus}
      className={cn(resolved.unmapped && 'border-dashed', className)}
    >
      <Icon name={resolved.glyph} size={12} />
      {resolved.text}
    </Badge>
  );
}

/**
 * The installation state of a plugin, derived and rendered in one call.
 *
 * This is the only thing a page should use to print "what state is this plugin in": it cannot
 * be given a second field to disagree with, and when the field is missing it says which one.
 */
export function InstallationStatus({ state, className }: { state?: string | null; className?: string }) {
  const t = useT();
  const derived = deriveInstallationState({ state });
  const detail = derived.missing.length
    ? t('status.missingField', { field: derived.missing.join(', ') })
    : derived.code;
  return <Status kind={derived.kind} detail={detail} className={className} />;
}

/**
 * Localized text for a wire code, for the places that cannot hold a component - a `<option>`
 * inside a native `<select>`, a toast line. Same table, same wording, no second vocabulary.
 */
export function useStatusText(): (code?: string | null) => string {
  const t = useT();
  return React.useCallback(
    (code?: string | null) => {
      const entry = statusForCode(code ?? undefined);
      return entry ? t(entry.labelKey) : t('status.unknown');
    },
    [t],
  );
}
