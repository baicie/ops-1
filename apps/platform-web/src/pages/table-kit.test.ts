import { afterEach, describe, expect, it, vi } from 'vitest';
import { cardActionCell, cardCellClass, copyIdAction, rankCardFacts } from './table-kit';

/**
 * The three primitives the card rules ride on (table-spec §2.1, §2.2, §2.5). A page can get each
 * of them wrong without a type error - "is the copy item the first one", "does a demoted cell
 * actually disappear", "which three columns does the card keep" - so they are asserted here
 * rather than only in a browser run that CI does not have.
 */

describe('copyIdAction', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('puts one enabled copy verb on the row, and writes the full id', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const onCopied = vi.fn();
    const action = copyIdAction('1285fbe8-9bb8-459f-b073-af245d32b3ae', 'Copy job ID', { onCopied });

    // One id for every table: "does this row offer the copy" is a single selector.
    expect(action.id).toBe('copy-id');
    expect(action.label).toBe('Copy job ID');
    expect(action.disabled).toBeUndefined();

    action.onSelect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeText).toHaveBeenCalledWith('1285fbe8-9bb8-459f-b073-af245d32b3ae');
    expect(onCopied).toHaveBeenCalledTimes(1);
  });

  it('reports a refused write instead of leaving an unhandled rejection', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const onFailed = vi.fn();

    copyIdAction('dev.opsweave.metrics', 'Copy identifier', { onFailed }).onSelect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onFailed).toHaveBeenCalledTimes(1);
  });
});

describe('cardCellClass', () => {
  it('drops a demoted column with a class the legacy table CSS cannot outrank', () => {
    // A Tailwind `hidden` utility loses to .nodes-table/.plugins-table's display rule at the same
    // breakpoint; that is how those two cards rendered 6 facts where §2.5 asks for 3.
    expect(cardCellClass(false)).toBe('ow-card-extra');
    expect(cardCellClass(true)).not.toBe('ow-card-extra');
    expect(cardActionCell).toContain('max-[768px]:absolute');
  });
});

describe('rankCardFacts', () => {
  it('keeps the three highest distinct ratios and never a fourth', () => {
    const varied = Array.from({ length: 12 }, (_, index) => 'v' + index);
    const constant = Array.from({ length: 12 }, () => 'READY');
    const quarter = Array.from({ length: 12 }, (_, index) => 'm' + (index % 4));
    expect(rankCardFacts({ varied, constant, quarter })).toEqual(['varied', 'quarter', 'constant']);
  });

  it('keeps caller order on a tie, so a card does not reshuffle between renders', () => {
    expect(rankCardFacts({ first: [], second: [] })).toEqual(['first', 'second']);
  });
});
