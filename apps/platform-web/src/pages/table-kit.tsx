import React from 'react';
import { Icon } from '../components/Icons';
import { Badge } from '../components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { TableCell } from '../components/ui/table';
import { Status } from '../components/app/status';
import { useT } from '../i18n';
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
