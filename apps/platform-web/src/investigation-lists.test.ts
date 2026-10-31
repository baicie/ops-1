import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// G12 F (P1-4). The investigation panel rendered three plain lists with the class the
// chronological timeline owns. .timeline li is a two-column grid whose first 12px is the
// marker, so the panel's content landed in that column and every statement became a 12px
// wide strip - at every width, in both themes, and no test noticed because markup is not
// layout. These assertions are the cheap half: they cannot see pixels, but they can see a
// list claiming to be a trail.
const here = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(here, 'components/investigation-panel.tsx'), 'utf8');
const css = readFileSync(join(here, 'styles.css'), 'utf8');

describe('the investigation panel lists records, not a trail', () => {
  it('never dresses a plain list as the timeline component', () => {
    expect(panel).not.toContain('className="timeline"');
  });

  it('uses the record list for all three of its lists', () => {
    for (const id of ['investigation-history-list', 'investigation-tools', 'investigation-hypotheses']) {
      expect(panel).toContain('className="record-list" data-testid="' + id + '"');
    }
  });

  it('keeps .record-list a column with a wrapping meta line, and says .timeline is a trail', () => {
    expect(css).toMatch(/\.record-list > li \{[^}]*flex-direction: column/);
    expect(css).toMatch(/\.record-list > li > \.record-line \{[^}]*flex-wrap: wrap/);
    expect(css).toContain('OWNERSHIP. .timeline is a CHRONOLOGICAL TRAIL');
  });

  it('binds the width of anything the panel quotes to the panel', () => {
    expect(css).toContain('[data-testid="incident-investigations"] pre');
    expect(css).toMatch(/\[data-testid="incident-investigations"\] pre,[\s\S]*overflow-wrap: anywhere/);
  });
});

