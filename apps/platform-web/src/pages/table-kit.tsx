import React from 'react';
import { Icon } from '../components/Icons';
import { Badge } from '../components/ui/badge';
import { TableCell } from '../components/ui/table';
import { STATUS_MAP, badgeVariantForTone, glyphForTone } from '../components/status-tone';
import { useT } from '../i18n';
import { cn } from '../lib/utils';

/**
 * Shared shadcn replacements for the two table pages migrated after Nodes.
 *
 * Kept out of the page files so Plugins and Governance render the same status pill and the
 * same <=760px card layout instead of growing two copies that drift apart.
 */

/** Replaces the legacy .status pill: a Badge, the same glyph, the same localized label. */
export function StatusPill({ status }: { status: string }) {
  const t = useT();
  const code = status?.toUpperCase();
  const known = code ? STATUS_MAP[code] : undefined;
  const tone = known?.tone ?? 'unknown';
  // A code the shared mapping does not know is protocol data, not copy: render it verbatim.
  const text = known ? t(known.labelKey) : status || t('status.unknown');
  return (
    <Badge variant={badgeVariantForTone(tone)} data-status={code || undefined} className={cn(!known && 'border-dashed')}>
      <Icon name={glyphForTone(tone)} size={12} />
      {text}
    </Badge>
  );
}

// The legacy .data-table card layout at <=760px (thead hidden, one row per record) keyed off
// the .data-table selector; these constants carry the same breakpoint as Tailwind variants so
// the tables no longer need that selector at all. Same constants as Nodes.tsx.
export const stackTable = 'max-[760px]:block';
export const stackHead = 'max-[760px]:hidden';
export const stackBody = 'max-[760px]:block';
export const stackRow = 'max-[760px]:flex max-[760px]:flex-col max-[760px]:px-1 max-[760px]:py-2.5';
const stackCell =
  'max-[760px]:flex max-[760px]:items-start max-[760px]:justify-between max-[760px]:gap-3.5 ' +
  'max-[760px]:border-0 max-[760px]:px-3.5 max-[760px]:py-[5px] max-[760px]:text-right';
const stackLabel = 'hidden text-muted-foreground max-[760px]:inline';

/** Table cell that keeps its data-label and prints that label inline only in the stacked layout. */
export function StackCell({ label, className, children, ...props }: React.TdHTMLAttributes<HTMLTableCellElement> & { label: string }) {
  return (
    <TableCell data-label={label} className={cn(stackCell, className)} {...props}>
      <span className={stackLabel}>{label}</span>
      {children}
    </TableCell>
  );
}
