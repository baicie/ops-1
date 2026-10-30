import React from 'react';
import { Icon } from '../components/Icons';
import { Badge } from '../components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { TableCell } from '../components/ui/table';
import { Status } from '../components/app/status';
import { useI18n, useT } from '../i18n';
import { cn } from '../lib/utils';

/**
 * Shared shadcn replacements for the list pages.
 *
 * Kept out of the page files so Plugins, Nodes and Governance render the same status pill,
 * the same row menu and the same record layout instead of growing three copies that drift.
 */

/**
 * Kept as the call-site name the pages already use; the rendering itself lives in
 * `components/app/status` so there is exactly one status renderer in the shell.
 *
 * The old body printed an unmapped code verbatim ("protocol data, not copy"). That is how
 * `STAGED` and `INSTALLED` reached the screen: every code the tone table did not know became
 * an English wire token sitting beside codes that had been translated. An unknown code now
 * reads "Unknown" with the code in a tooltip and in `data-status`.
 */
export function StatusPill({ status }: { status: string }) {
  return <Status code={status} />;
}

// ONE breakpoint for the record layout. V5 shipped two: these constants stacked the table at
// 760px while the card CSS in styles.css started at 768px, so 761-768px rendered a table that
// was already display:block with none of the label styling - a column-less stack of bare
// values. 768px now, in both files.
export const RECORD_BREAKPOINT = 768;
export const stackTable = 'max-[768px]:block';
export const stackHead = 'max-[768px]:hidden';
export const stackBody = 'max-[768px]:block';
export const stackRow = 'max-[768px]:flex max-[768px]:flex-col max-[768px]:px-1 max-[768px]:py-2.5';
const stackCell =
  'max-[768px]:flex max-[768px]:items-start max-[768px]:justify-between max-[768px]:gap-3.5 ' +
  'max-[768px]:border-0 max-[768px]:px-3.5 max-[768px]:py-[5px] max-[768px]:text-right';
// The legacy .data-table/.responsive-table label was a ::before with flex: none, so it never
// shrank. Without shrink-0 a wide value on the right squeezes the label and wraps it ("任 / 务").
const stackLabel = 'hidden shrink-0 whitespace-nowrap text-muted-foreground max-[768px]:inline';

/** Table cell that keeps its data-label and prints that label inline only in the stacked layout. */
export function StackCell({ label, className, children, ...props }: React.TdHTMLAttributes<HTMLTableCellElement> & { label: string }) {
  return (
    <TableCell data-label={label} className={cn(stackCell, className)} {...props}>
      <span className={stackLabel}>{label}</span>
      {children}
    </TableCell>
  );
}

/**
 * One row action. `disabledReason` is why an action the operator might expect is not offered:
 * the menu shows it greyed with the reason instead of hiding it, so "there is no Stop here"
 * becomes a stated fact (the plugin is already disabled) rather than a dead end.
 */
export interface RowAction {
  id: string;
  label: string;
  icon: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  /** Draw a divider above this item. */
  divider?: boolean;
}

/**
 * The per-row verb menu. Every list row gets the same trigger: a 28px icon button with the
 * same accessible name pattern and the same keyboard behaviour, so an operator who learned
 * one table can act on the next one.
 */
export function RowActions({ label, actions, onOpenChange }: { label: string; actions: RowAction[]; onOpenChange?: (open: boolean) => void }) {
  const t = useT();
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="icon-btn"
          aria-label={label}
          data-testid="row-actions"
          // The row itself is a click target (it opens the entity); the menu must not.
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Icon name="down" size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        {actions.map((action) => (
          <React.Fragment key={action.id}>
            {action.divider ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              data-action={action.id}
              disabled={action.disabled}
              title={action.disabled ? action.disabledReason : undefined}
              className={cn(action.danger && 'text-[var(--ow-danger)] focus:text-[var(--ow-danger)]')}
              onSelect={() => { if (!action.disabled) action.onSelect(); }}
            >
              <Icon name={action.icon} size={14} /> {action.label}
              {action.disabled && action.disabledReason ? <span className="sr-only">{action.disabledReason}</span> : null}
            </DropdownMenuItem>
          </React.Fragment>
        ))}
        {actions.length === 0 ? <DropdownMenuItem disabled>{t('common.none')}</DropdownMenuItem> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ── table-spec §2.1: one identity per row, in human language ───────────────────────── */

/** Above this row count 4 hex characters stop being enough; §2.1 derives 8 for its reason. */
export const IDENTITY_MANY_ROWS = 100;

export interface Identity {
  /** What the row is called: ⟨name⟩ · ⟨disambiguator⟩ · ⟨age⟩. */
  key: string;
  name: string;
  disambiguator: string;
  age: string;
  fullId: string | null;
}

/** §2.1 names Intl.RelativeTimeFormat as the age source; the unit ladder matches TimeAgo. */
export function relativeAge(locale: string, at?: string | null): string {
  if (!at) return '';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < 60) return format.format(seconds, 'second');
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return format.format(Math.round(seconds / 3600), 'hour');
  return format.format(Math.round(seconds / 86400), 'day');
}

/**
 * §2.1: the canonical UUID first 4 hex characters, and only when the name is not unique on
 * the page (8 characters above 100 rows). The full id is never displayed - it goes to the
 * title and to the row menu copy item.
 */
export function formatIdentity(options: {
  name: string;
  id?: string | null;
  at?: string | null;
  locale: string;
  nameIsUnique?: boolean;
  rowsOnPage?: number;
}): Identity {
  const { name, id, at, locale, nameIsUnique = true, rowsOnPage = 0 } = options;
  const hex = String(id || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  const width = rowsOnPage > IDENTITY_MANY_ROWS ? 8 : 4;
  const disambiguator = nameIsUnique || hex.length < width ? '' : hex.slice(0, width);
  const age = relativeAge(locale, at);
  return {
    key: [name, disambiguator, age].filter(Boolean).join(' · '),
    name,
    disambiguator,
    age,
    fullId: id || null,
  };
}

/**
 * The one identity cell. title carries the full id; data-identity-key is the machine
 * reading of the cell the audit harness compares for uniqueness (table-spec §4.1).
 *
 * cardFact marks the <=3 columns §2.5 keeps at 390; every other cell is a desktop column the
 * card drops, not information that was deleted.
 */
export function IdentityCell({
  label,
  identity,
  cardFact,
  className,
  children,
}: {
  label: string;
  identity: Identity;
  cardFact?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <TableCell
      data-label={label}
      data-column={label}
      title={identity.fullId || undefined}
      data-card-fact={cardFact ? '' : undefined}
      className={cn(stackCell, 'ow-ident-cell max-[768px]:text-left', className)}
    >
      <span className={cn(stackLabel, 'max-[768px]:hidden')}>{label}</span>
      <span className="ow-ident" data-identity-key={identity.key}>
        <span className="ow-ident-name">{identity.name}</span>
        {identity.disambiguator || identity.age ? (
          <span className="ow-ident-tail">
            {identity.disambiguator ? ' · ' + identity.disambiguator : ''}
            {identity.age ? ' · ' + identity.age : ''}
          </span>
        ) : null}
      </span>
      {children ? <span className="ow-ident-meta">{children}</span> : null}
    </TableCell>
  );
}

/** §2.1: the full id is one click away - a 36-character UUID cannot be transcribed by eye. */
export function copyIdAction(id: string, label: string): RowAction {
  return {
    id: 'copy-id',
    label,
    icon: 'copy',
    onSelect: () => {
      void navigator.clipboard?.writeText(id);
    },
  };
}

/* ── table-spec §2.4: three in a row is one fact ────────────────────────────────────── */

export interface CollapsedRun<T> {
  /** The row the run is rendered with: the first occurrence (§2.4). */
  row: T;
  /** 1 for a row that is its own fact; >= threshold for a collapsed run. */
  count: number;
  /** The last occurrence timestamp, for the run first -> last span. */
  lastAt: string;
  key: string;
}

/**
 * Consecutive rows sharing a key collapse into one entry once the run reaches threshold.
 * Threshold 3: 2 identical rows can be two genuine actions and collapsing a pair hides one;
 * 3 on one page can only be a poller, a fan-out or a retry loop.
 */
export function collapseRuns<T>(
  rows: T[],
  keyOf: (row: T) => string,
  at: (row: T) => string,
  threshold = 3,
): CollapsedRun<T>[] {
  const out: CollapsedRun<T>[] = [];
  let index = 0;
  while (index < rows.length) {
    const key = keyOf(rows[index]);
    let end = index;
    while (end + 1 < rows.length && keyOf(rows[end + 1]) === key) end += 1;
    const count = end - index + 1;
    if (count >= threshold) {
      out.push({ row: rows[index], count, lastAt: at(rows[end]), key });
      index = end + 1;
    } else {
      for (let i = index; i <= end; i += 1) out.push({ row: rows[i], count: 1, lastAt: at(rows[i]), key });
      index = end + 1;
    }
  }
  return out;
}

/* ── table-spec §2.2 / §2.5: which columns earn the card ────────────────────────────── */

/**
 * Distinct-value ratio per column over the rows on screen, highest first. §2.2 keeps a
 * column at >= 0.2; §2.5 card keeps the top 3 by the same ranking. Stable: ties keep the
 * caller order, so the card does not reshuffle between renders.
 */
export function rankCardFacts(
  columns: Record<string, Array<string | number | null | undefined>>,
  max = 3,
): string[] {
  return Object.keys(columns)
    .map((key, order) => {
      const values = columns[key].map((value) => (value === null || value === undefined ? '' : String(value)));
      const nonEmpty = values.filter((value) => value !== '');
      const ratio = values.length && nonEmpty.length >= 10 ? new Set(nonEmpty).size / values.length : 0;
      return { key, ratio, order };
    })
    .sort((left, right) => (right.ratio - left.ratio) || (left.order - right.order))
    .slice(0, max)
    .map((entry) => entry.key);
}

/** The desktop-only cell of a demoted column: present in the table, dropped on the card. */
export function cardCellClass(isCardFact: boolean): string {
  return isCardFact ? 'max-[768px]:block' : 'max-[768px]:hidden';
}
