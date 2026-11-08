import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The token layer, held to the four rules the v3 audit found broken. These are source-text
 * assertions on purpose: each one caught a real defect that no component test can see, and
 * each one is cheap enough that nobody has a reason to skip it.
 */
const css = readFileSync(join(__dirname, 'styles.css'), 'utf8');
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('styles.css token contract', () => {
  it('declares its tokens exactly once', () => {
    expect(cssNoComments.match(/^:root \{/gm) ?? []).toHaveLength(1);
    expect(cssNoComments.match(/^html\[data-theme="dark"\] \{/gm) ?? []).toHaveLength(1);
    // body used to be written twice: 13px from the token, then a literal 13.5px that won.
    expect(cssNoComments.match(/^body \{/gm) ?? []).toHaveLength(1);
  });

  it('has no font size below 11px and no literal font size left', () => {
    const literals = [...cssNoComments.matchAll(/font-size:\s*([\d.]+)px/g)];
    expect(literals.map((m) => m[0])).toEqual([]);
    // A clamp() is a token value, not a declaration, so only bare px would show up above.
    expect(css).not.toContain('8.5px');
    expect(css).not.toContain('9.5px');
  });

  it('implements the four job tiers and the named title clamp', () => {
    // ADR-017 §D5 and the DS-V1-1b rename: four tokens, one value each. The title is the
    // one clamp: 26px maximum, a measured 20px floor at 390, carried as a named gate
    // exception rather than a budget finding.
    expect(css).toMatch(/--ow-type-label: 11px;/);
    expect(css).toMatch(/--ow-type-meta: 13px;/);
    expect(css).toMatch(/--ow-type-body: 15px;/);
    expect(css).toMatch(/--ow-type-title: clamp\(20px, 2\.1vw, 26px\);/);
    // The metric figure is a named display exception, not a fifth tier: at 26 the KPI zeros
    // measured louder than the health verdict. The four job tiers are label/meta/body/title.
    expect(css).toMatch(/--ow-type-metric: 21px;/);
  });

  it('leaves .truncate and .block to Tailwind', () => {
    expect(cssNoComments).not.toMatch(/^\.truncate \{/m);
    expect(cssNoComments).not.toMatch(/^\.block \{/m);
    // The one app form that needs a block box states it on its own selector.
    expect(cssNoComments).toMatch(/td a\.truncate[^{]*\{/);
  });

  it('names one card radius and uses it for every card primitive', () => {
    expect(css).toMatch(/--ow-radius-card: 10px;/);
    // G12 D removed the .investigation-region primitive: the investigation workspace is built
    // from .panel cards now (the rail is a panel, and each pane is a column of them), so the
    // card-radius contract for that surface is the .panel entry below. A selector that no longer
    // exists cannot be held to a radius, and leaving it in this list would only make it rot.
    for (const primitive of ['.panel {', '.ow-metric {', '.module-card {', '.ow-summary-card {', '.async-panel {']) {
      const start = cssNoComments.indexOf(primitive);
      expect(start, primitive + ' must exist').toBeGreaterThan(-1);
      const rule = cssNoComments.slice(start, cssNoComments.indexOf('}', start));
      expect(rule, primitive + ' must read the card radius').toContain('var(--ow-radius-card)');
    }
  });
});
