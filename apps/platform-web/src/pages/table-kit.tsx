import React from 'react';
import { Icon } from '../components/Icons';
import { CopyButton } from '../components/Ui';
import { Badge } from '../components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { TableCell } from '../components/ui/table';
import { Status } from '../components/app/status';
import { useI18n, useT, type Locale } from '../i18n';
import { ageMessage } from '../lib/age';
import { IDENTITY_MANY_ROWS, identityDisambiguator } from '../lib/identity';
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
// py-1.5, not py-2.5: §2.5's card is 12 padding + 20 identity + 8 gap + 3 x 22 facts + 12
// padding + 12 slack - 12 of padding in total, so 6 a side. 10px a side spent the slack the
// three facts needed (measured 142.6 on /admin/jobs). relative: the menu rides the identity line.
export const stackRow = 'max-[768px]:relative max-[768px]:flex max-[768px]:flex-col max-[768px]:px-1 max-[768px]:py-1.5';
const stackCell =
  'max-[768px]:flex max-[768px]:items-start max-[768px]:justify-between max-[768px]:gap-3.5 ' +
  'max-[768px]:border-0 max-[768px]:px-3.5 max-[768px]:py-1 max-[768px]:text-right';
// The legacy .data-table/.responsive-table label was a ::before with flex: none, so it never
// shrank. Without shrink-0 a wide value on the right squeezes the label and wraps it ("任 / 务").
const stackLabel = 'hidden shrink-0 whitespace-nowrap text-muted-foreground max-[768px]:inline';

/**
 * Table cell that keeps its data-label and prints that label inline only in the stacked layout.
 *
 * The value rides a .ow-cell-body block. At ≥768 that block reserves the two-tier height of §2.3
 * (15.6 value + 15.4 qualifier = 31), so a cell that prints one line and the identity cell beside
 * it that prints two start on the same band instead of 8px apart - the "centre vs top" step the
 * review measured between neighbouring cells of one row. At <768 the wrapper is `display:
 * contents`, so the card keeps laying its facts out as direct children of the cell.
 */
export function StackCell({ label, className, children, ...props }: React.TdHTMLAttributes<HTMLTableCellElement> & { label: string }) {
  return (
    <TableCell data-label={label} className={cn(stackCell, className)} {...props}>
      <span className={stackLabel}>{label}</span>
      <span className="ow-cell-body">{children}</span>
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
export { IDENTITY_MANY_ROWS };

/**
 * What the row is called: ⟨name⟩ · ⟨disambiguator⟩.
 *
 * The age is deliberately NOT part of the key. It was, and the audit measured it: two rows that
 * the reader cannot tell apart ("host-metrics · 1285 · 18 hours ago" / "host-metrics · 1285 ·
 * 17 hours ago") counted as two distinct identities, so §2.1's uniqueness assertion went green
 * on the one field that is already printed in its own column one cell to the right. An identity
 * key that contains a clock stops being an identity the moment the clock ticks.
 *
 * The age still travels on the Identity (the cell puts it in `title`), just not in the key.
 */
export interface Identity {
  key: string;
  name: string;
  disambiguator: string;
  age: string;
  fullId: string | null;
}

/**
 * §2.1's age, from the one ladder the shell has (lib/age.ts).
 *
 * This used to be `Intl.RelativeTimeFormat`, which is a correct formatter and a second dialect:
 * the same row printed "24m ago" in its Occurred cell (the catalog form) and "3 hours ago" in the
 * span of its run (this form). Two spellings of one fact on one line is the thing §1.4 called out,
 * so the span now reads what the cell reads.
 */
export function relativeAge(locale: string, at?: string | null): string {
  return ageMessage(locale as Locale, at);
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
  const disambiguator = nameIsUnique ? '' : identityDisambiguator(id, rowsOnPage);
  const age = relativeAge(locale, at);
  return {
    key: [name, disambiguator].filter(Boolean).join(' · '),
    name,
    disambiguator,
    age,
    fullId: id || null,
  };
}

/**
 * The one identity cell. title carries the full id and the age; data-identity-key is the machine
 * reading of the cell the audit harness compares for uniqueness (table-spec §4.1).
 *
 * The visible line is ⟨name⟩ · ⟨disambiguator⟩ only: the age has a column of its own in every
 * table that renders this cell, and printing it twice in one row is what let a duplicated
 * timestamp pass for a distinguishing one.
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
      title={[identity.fullId, identity.age].filter(Boolean).join(' · ') || undefined}
      data-card-fact={cardFact ? '' : undefined}
      className={cn(stackCell, 'ow-ident-cell max-[768px]:text-left', className)}
    >
      <span className={cn(stackLabel, 'max-[768px]:hidden')}>{label}</span>
      <span className="ow-ident" data-identity-key={identity.key}>
        <span className="ow-ident-name">{identity.name}</span>
        {identity.disambiguator ? <span className="ow-ident-tail">{' · ' + identity.disambiguator}</span> : null}
      </span>
      {/* Always rendered, so an identity cell without a qualifier still reserves §2.3's qualifier
          track and its first line lines up with every other cell in the row. It is emptied by CSS
          at 390 (display:none when :empty), where a card must not spend 15px on nothing. */}
      <span className="ow-ident-meta">{children}</span>
    </TableCell>
  );
}

/**
 * §2.1: the full id is one click away - a 36-character UUID cannot be transcribed by eye - and
 * it is the FIRST item of the row menu. One id ('copy-id') for every table, so "does this row
 * offer the copy" is one selector instead of one per page. The hooks let a page keep its own
 * confirmation without re-implementing the write; a refused write is reported, never left as an
 * unhandled rejection.
 */
export function copyIdAction(
  id: string,
  label: string,
  hooks: { onCopied?: () => void; onFailed?: () => void } = {},
): RowAction {
  return {
    id: 'copy-id',
    label,
    icon: 'copy',
    onSelect: () => {
      const write = navigator.clipboard?.writeText(id);
      if (!write) { hooks.onFailed?.(); return; }
      write.then(() => hooks.onCopied?.(), () => hooks.onFailed?.());
    },
  };
}

/**
 * §2.6: one identifier, one line.
 *
 * A mono run with no spaces has a min-content width of one character, and the <=768 rule that
 * stops the phone scrolling sideways ("the container never scrolls") spends exactly that. The 390
 * review measured a 36-character node id in the attempts table laid out as 10 line boxes of 3.6
 * characters in a 59.9px column - unreadable, and invisible to an assertion that only compares
 * documentElement.scrollWidth with clientWidth.
 *
 * `display` is what a reader needs to tell this row from the next one: a four-hex disambiguator
 * from lib/identity (the one rule every table uses for "what is this row called") or a head…tail
 * digest. `scroll` instead puts the whole value in its own bounded horizontal scroller, for the
 * fields an operator has to read or transcribe in full - that box scrolls, the page does not.
 * Either way the full value is in the tooltip and on the copy button, so shortening a value never
 * removes it from the screen.
 */
export function LongId({ value, display, label, scroll = false, testId, className }: {
  value?: string | null;
  /** What is printed; the full `value` stays in the title and on the clipboard. */
  display?: string;
  label: string;
  scroll?: boolean;
  testId?: string;
  className?: string;
}) {
  if (!value) return <span className="muted">{'\u2014'}</span>;
  return (
    <span className={cn('ow-longid', className)}>
      <span className="ow-longid-value" title={value} data-scroll={scroll ? '' : undefined} data-testid={testId}>{display ?? value}</span>
      <CopyButton value={value} label={label} testId={testId ? testId + '-copy' : undefined} />
    </span>
  );
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

/**
 * The desktop-only cell of a demoted column: present in the table, dropped on the card.
 *
 * A class of its own, not the `hidden` utility: .nodes-table/.plugins-table set
 * `display: flex` on tbody td at the same breakpoint (specificity 0,1,2), which outranks every
 * Tailwind utility (0,1,0) - that is why those two tables rendered 6 facts on a card that asks
 * for 3 while /admin/jobs, whose table carries no legacy class, rendered 3.
 */
export function cardCellClass(isCardFact: boolean): string {
  return isCardFact ? 'max-[768px]:block' : 'ow-card-extra';
}

/**
 * §2.5: the row menu rides the identity line at 390 instead of taking a line of its own - that
 * alone was 32 of today's 239px. The cell must not carry a label: a labelled cell is a fact.
 */
export const cardActionCell = 'max-[768px]:absolute max-[768px]:right-1 max-[768px]:top-2 max-[768px]:w-auto max-[768px]:border-0 max-[768px]:p-0';
