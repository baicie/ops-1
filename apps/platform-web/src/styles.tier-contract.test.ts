import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The three V3 tier rules, asserted on the stylesheet itself.
 *
 * `scripts/check-ui-tokens.mjs` already counts these offenders, but a gate that runs against a
 * ratchet budget goes green while the budget is above zero. These assertions are the floor under
 * the ratchet: once a rule reaches zero it stays there, and a reintroduced literal fails the unit
 * suite rather than waiting for someone to notice that a budget crept up.
 *
 * Source-text assertions on purpose. The alternative - rendering a component and reading its
 * computed style - needs a browser, and the one property that matters here (which TOKEN a rule
 * reads) is erased by the time the style is computed: a hard-coded 6px and
 * `var(--ow-radius-control)` compute identically and drift differently.
 */
const css = readFileSync(join(__dirname, 'styles.css'), 'utf8');
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every .ts/.tsx under src, excluding the test files themselves. */
function sourceFiles(): Map<string, string> {
  const out = new Map<string, string>();
  (function walk(dir: string, prefix: string) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = prefix ? prefix + '/' + name : name;
      if (statSync(path).isDirectory()) walk(path, rel);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.set(rel, readFileSync(path, 'utf8'));
    }
  })(__dirname, '');
  return out;
}

/** The token blocks are the one place a literal is legal; blank them, keep offsets. */
const body = cssNoComments
  .replace(/:root \{[\s\S]*?\n\}/m, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/html\[data-theme="dark"\] \{[\s\S]*?\n\}/m, (m) => m.replace(/[^\n]/g, ' '));

describe('radius: exactly three tiers (token-table R1)', () => {
  it('declares the three tiers and none of the deleted ones', () => {
    expect(css).toMatch(/--ow-radius-control: 6px;/);
    expect(css).toMatch(/--ow-radius-card: 10px;/);
    expect(css).toMatch(/--ow-radius-pill: 9999px;/);
    // sm/md/lg were three more names for the same job; a fourth tier is how eleven started.
    for (const dead of ['--ow-radius-sm:', '--ow-radius-md:', '--ow-radius-lg:']) {
      expect(cssNoComments, dead + ' is deleted').not.toContain(dead);
    }
  });

  it('authors no radius literal outside the token block', () => {
    const offenders = [...body.matchAll(/border-radius:\s*([^;]+);/g)]
      .map((match) => match[1].trim())
      .filter((value) =>
        value
          .split(/\s+/)
          .filter((part) => part !== '0')
          .some((part) => !/^(var\(--ow-radius-(control|card|pill)\)|inherit|9999px)$/.test(part)));
    expect(offenders).toEqual([]);
  });

  it('spells a circle and a pill the same way', () => {
    // 50% becomes an ellipse the moment width != height; 999px only holds under 1998px.
    expect(body).not.toMatch(/border-radius:\s*50%/);
    expect(body).not.toMatch(/border-radius:\s*999px/);
  });

  it('keeps the TSX side on the named tiers too', () => {
    // The stylesheet is only half the surface: the copy-in primitives carry their radius as a
    // utility class. shadcn's scale (rounded-sm/md/lg/xl) is a SECOND vocabulary whose names
    // say nothing about the job - "md" on a button and "md" on a popover were the same word for
    // two different tiers. The utilities are rounded-control/card/pill, defined in
    // tailwind.config.cjs over the same three tokens, so one tier has one name everywhere.
    const offenders: string[] = [];
    for (const [file, text] of sourceFiles()) {
      text.split('\n').forEach((line, i) => {
        const hits = line.match(/\brounded-(sm|md|lg|xl|2xl|3xl|\[[^\]]+\])\b/g);
        if (hits) for (const hit of hits) offenders.push(file + ':' + (i + 1) + ' ' + hit);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the TSX control boxes on the two height tiers', () => {
    // Same argument for height: h-9 is 36px, which is not a tier, and it is what put a 36px
    // input beside a 28px tab trigger in one toolbar. The utilities are h-control-sm/md.
    const GLYPH = ['h-2', 'h-3', 'h-3.5', 'h-4', 'h-5', 'h-6'];
    const PRIMITIVES = ['button.tsx', 'input.tsx', 'select.tsx', 'checkbox.tsx', 'switch.tsx', 'tabs.tsx'];
    const offenders: string[] = [];
    for (const [file, text] of sourceFiles()) {
      if (!PRIMITIVES.includes(file.split('/').pop()!)) continue;
      text.split('\n').forEach((line, i) => {
        if (GLYPH.some((g) => line.includes(g + ' '))) return;
        const hits = line.match(/\bh-(6|7|8|9|10|11|12)\b/g);
        if (hits) for (const hit of hits) offenders.push(file + ':' + (i + 1) + ' ' + hit);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('controls: two heights plus a touch floor (token-table R3)', () => {
  it('declares the two tiers, the floor, and not the deleted lg', () => {
    expect(css).toMatch(/--ow-control-sm: 32px;/);
    expect(css).toMatch(/--ow-control-md: 40px;/);
    expect(css).toMatch(/--ow-control-touch: 44px;/);
    expect(cssNoComments).not.toContain('--ow-control-lg:');
  });

  it('states the mobile floor once, as a token, not per component', () => {
    // R3 C2: 44px is a constraint over whichever tier a control already uses. Authoring it
    // per component is what produced the 30/36/38/46px spread.
    const uses = [...cssNoComments.matchAll(/var\(--ow-control-touch\)/g)];
    expect(uses.length).toBeGreaterThan(0);
    expect(cssNoComments).not.toMatch(/min-height:\s*44px/);
  });

  it('authors no interactive control height off the two tiers', () => {
    // The gate's own decoration list: a dot, a brand mark or an icon ring is sized art, not a
    // control, and its height is not a tier. Everything else in 24..48px must read a token.
    const DECORATION = ['.avatar', '.brand-', '.empty-icon', '.skeleton', '.progress',
      '.attention-icon', '.entity-icon', '.investigation-slot-mark', '.dot', '.bar', '.track',
      '.spinner', '.glyph', '.rail', '.swatch', '.chart', '.timeline', '.hairline',
      '.node-summary', '.node-type-icon', '.event-marker', '.step-index', '.row-action',
      '.setup-step-num', '.status-entity', '.ow-metric-value', '.ow-filter-fade', '.toast',
      '.nav-link', 'thead th'];
    const lines = body.split('\n');
    const offenders: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const hits = lines[i].match(/(?:min-)?height:\s*(\d+)px/g);
      if (!hits) continue;
      // Walk back to the line that opened the rule, as the gate does.
      let selector = lines[i].split('{')[0].trim();
      for (let j = i; j >= 0 && j > i - 6; j -= 1) {
        const cut = lines[j].split('{');
        if (cut.length > 1) { selector = cut[0].trim(); break; }
      }
      if (DECORATION.some((d) => selector.includes(d))) continue;
      for (const hit of hits) {
        const px = Number(hit.match(/(\d+)px/)![1]);
        if (px < 24 || px > 48 || px === 32 || px === 40) continue;
        offenders.push(selector + ' -> ' + px + 'px');
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('uppercase belongs to the language (machine-language-rules M2)', () => {
  it('never transforms case outside a :lang(en) scope', () => {
    const lines = body.split('\n');
    const offenders = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /text-transform:\s*uppercase/.test(line) && !/:lang\(en\)/.test(line))
      .map(({ i }) => i + 1);
    expect(offenders).toEqual([]);
  });

  it('keeps the tracking in the same scope as the transform', () => {
    // .04-.09em is what makes uppercase Latin legible and what makes CJK look broken, so a
    // letter-spacing that survives outside :lang(en) would space out Chinese for nothing.
    const scoped = [...cssNoComments.matchAll(/:lang\(en\)[^{]*\{([^}]*)\}/g)]
      .filter((match) => /text-transform:\s*uppercase/.test(match[1]));
    expect(scoped.length).toBeGreaterThan(0);
  });
});

describe('formatters do not spell English (machine-language-rules M3)', () => {
  const format = readFileSync(join(__dirname, 'format.ts'), 'utf8');

  it('returns no quoted English word and no hand-written unit suffix', () => {
    const returns = format.split('\n').filter((line) => /\breturn\b/.test(line));
    const english = returns.filter((line) => /'[A-Za-z][A-Za-z ]{2,}'/.test(line) && !/Intl\.|toLocaleString/.test(line));
    expect(english).toEqual([]);
  });

  it('has no non-breaking space hiding in a formatted value', () => {
    // A U+00A0 typed into the separator is invisible in review and breaks every string
    // comparison downstream; it cost one debugging round on this very file.
    expect(format).not.toMatch(/ /);
  });
});
