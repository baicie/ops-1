import * as React from 'react';
import { cn } from '../../lib/utils';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog';
import { Sheet, SheetContent } from './sheet';

export interface CommandEntry {
  id: string;
  /** Localized label; the caller resolves it from the catalog. */
  label: string;
  path: string;
  /** Extra searchable words (route id, group label) that never render as copy. */
  keywords?: string[];
}

export interface CommandLabels {
  title: string;
  placeholder: string;
  empty: string;
  results: string;
  hint: string;
}

/**
 * Case-insensitive substring match over the label, the route and any keywords.
 *
 * Deliberately dependency free: a fuzzy-score library would be the first npm addition to a
 * component that only has to search ten destinations, and the shell must stay free of a
 * second search stack.
 */
export function filterEntries(entries: CommandEntry[], query: string): CommandEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) => {
    const haystack = [entry.label, entry.path, entry.id, ...(entry.keywords ?? [])].join(' ').toLowerCase();
    return haystack.includes(needle);
  });
}

/** ⌘K on Apple platforms, Ctrl+K elsewhere; both open the same palette. */
export function useCommandShortcut(onOpen: () => void) {
  const handler = React.useRef(onOpen);
  handler.current = onOpen;
  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      handler.current();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: CommandEntry[];
  labels: CommandLabels;
  /** Drawer presentation for tablet/phone widths; the desktop keeps the centred dialog. */
  compact?: boolean;
  onSelect: (entry: CommandEntry) => void;
  closeLabel: string;
}

/**
 * Navigation command palette: ArrowUp/ArrowDown move, Enter opens, Escape closes (Radix
 * dialog), and \`aria-activedescendant\` keeps the highlighted option announced while the
 * focus stays in the input.
 */
export function CommandPalette({ open, onOpenChange, entries, labels, compact = false, onSelect, closeLabel }: CommandPaletteProps) {
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState(0);
  const results = React.useMemo(() => filterEntries(entries, query), [entries, query]);

  React.useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
  }, [open]);

  React.useEffect(() => {
    setActive(0);
  }, [query]);

  React.useEffect(() => {
    if (!open) return;
    document.getElementById('command-option-' + (results[active]?.id ?? ''))?.scrollIntoView({ block: 'nearest' });
  }, [active, open, results]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => (current + delta + results.length) % results.length);
      return;
    }
    if (event.key === 'Enter') {
      const target = results[active];
      if (!target) return;
      event.preventDefault();
      onSelect(target);
    }
  }

  const activeId = results[active] ? 'command-option-' + results[active].id : undefined;

  const body = (
    <div className="ow-command" data-testid="command-palette">
      <input
        autoFocus
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="command-results"
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-label={labels.placeholder}
        placeholder={labels.placeholder}
        className="ow-command-input"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={handleKeyDown}
        data-testid="command-input"
      />
      <ul id="command-results" role="listbox" aria-label={labels.results} className="ow-command-list">
        {results.map((entry, index) => (
          <li
            key={entry.id}
            id={'command-option-' + entry.id}
            role="option"
            aria-selected={index === active}
            className={cn('ow-command-item', index === active && 'is-active')}
            onMouseEnter={() => setActive(index)}
            onClick={() => onSelect(entry)}
            data-testid="command-option"
            data-path={entry.path}
          >
            <span className="ow-command-label">{entry.label}</span>
            <span className="ow-command-path" aria-hidden="true">{entry.path}</span>
          </li>
        ))}
      </ul>
      {results.length === 0 ? <p className="ow-command-empty" role="status">{labels.empty}</p> : null}
      <p className="ow-command-hint">{labels.hint}</p>
    </div>
  );

  const dialogProps = { open, onOpenChange } as const;

  if (compact) {
    return (
      <Sheet {...dialogProps}>
        <SheetContent side="left" title={labels.title} closeLabel={closeLabel} className="ow-command-sheet">
          {body}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog {...dialogProps}>
      <DialogContent className="ow-command-dialog" closeLabel={closeLabel}>
        <DialogTitle className="sr-only">{labels.title}</DialogTitle>
        <DialogDescription className="sr-only">{labels.hint}</DialogDescription>
        {body}
      </DialogContent>
    </Dialog>
  );
}
