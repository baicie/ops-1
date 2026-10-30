import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The source-text half of `docs/design/ui-visual-v3/code-rules.md`.
 *
 * Each assertion below stands for one rule that was broken at least once in this tree, in a way
 * no component test can see: a CSS rule nothing renders, a block pasted twice, an unhandled
 * clipboard rejection, a status table read by index. They are source-text assertions on purpose -
 * the same idiom as `styles.token-contract.test.ts`, and cheap enough that nobody skips them.
 */
const SRC = __dirname;
const css = readFileSync(join(SRC, 'styles.css'), 'utf8');
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every leaf block `selector { declarations }`, with its 1-based line. */
function leafBlocks(): { selector: string; body: string; line: number }[] {
  const blocks: { selector: string; body: string; line: number }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(cssNoComments))) {
    const selector = match[1].trim().replace(/\s+/g, ' ');
    const line = cssNoComments.slice(0, match.index).split('\n').length;
    blocks.push({ selector, body: match[2].trim(), line });
  }
  return blocks;
}

function sourceText(): Map<string, string> {
  const files = new Map<string, string>();
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(tsx?|json)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        files.set(path.slice(SRC.length + 1), readFileSync(path, 'utf8'));
      }
    }
  })(SRC);
  return files;
}

/**
 * Classes a third-party component emits at runtime. They are the only selectors in `styles.css`
 * whose name is not written by this repository.
 */
const THIRD_PARTY_CLASS = /^(react-flow__|rf__|ProseMirror|cm-)/;

describe('code rules: no CSS that nothing can render', () => {
  it('every class selector is reachable from a source file', () => {
    const files = sourceText();
    const text = [...files.values()].join('\n');
    const orphans = new Set<string>();
    for (const { selector } of leafBlocks()) {
      for (const [, name] of selector.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) {
        if (THIRD_PARTY_CLASS.test(name) || /^max-|^min-|^\d/.test(name)) continue;
        if (text.includes(name)) continue;
        orphans.add(name);
      }
    }
    // A class the templates build (`value-token--${token}`) is not textual and IS reachable.
    const QUOTE = String.fromCharCode(39);
    const DOUBLE = String.fromCharCode(34);
    const dynamic = [...orphans].filter((name) => {
      const parts = name.split('-');
      for (let i = 1; i < parts.length; i += 1) {
        const prefix = parts.slice(0, i).join('-') + '-';
        // Built by a template (`value-token--${token}`) or by concatenation ('health-' + tone).
        if (text.includes(prefix + '$' + '{')) return true;
        if (text.includes(prefix + QUOTE) || text.includes(prefix + DOUBLE)) return true;
      }
      return false;
    });
    expect([...orphans].filter((name) => !dynamic.includes(name))).toEqual([]);
  });

  it('no block is a restatement of the block above it', () => {
    const blocks = leafBlocks();
    const restated: string[] = [];
    for (let i = 1; i < blocks.length; i += 1) {
      const prev = blocks[i - 1];
      const current = blocks[i];
      if (current.selector === prev.selector && current.body === prev.body && current.line - prev.line <= 3) {
        restated.push(current.selector + ' @' + current.line);
      }
    }
    expect(restated).toEqual([]);
  });
});

describe('code rules: a promise is either awaited or handled', () => {
  it('never discards a clipboard write with `void`', () => {
    const offenders = [...sourceText().entries()]
      .filter(([, text]) => /void\s+navigator\.clipboard/.test(text))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});

describe('code rules: the status table is read fail-closed', () => {
  /**
   * `STATUS_MAP[code].tone` is how two pages crashed on a code the table did not carry. A read
   * outside `status-tone.ts` is allowed only when the same expression states what happens when
   * the code is absent: an optional chain, a nullish fallback, or a ternary with `undefined`.
   */
  it('every index into STATUS_MAP states its fallback', () => {
    const offenders: string[] = [];
    for (const [name, text] of sourceText()) {
      if (name === join('components', 'status-tone.ts')) continue;
      text.split('\n').forEach((line, index) => {
        if (!/STATUS_MAP\[/.test(line)) return;
        if (/\?\.|\?\?|:\s*undefined|&&/.test(line)) return;
        offenders.push(name + ':' + (index + 1));
      });
    }
    expect(offenders).toEqual([]);
  });
});
