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

describe('code rules: a write is verified by a re-read, not by its own response', () => {
  /**
   * A5 (§2 of docs/design/ui-visual-v3/code-rules.md). `InstallWizard.deploy()` used to take the
   * body of `POST /plugins/{id}/deployments` and render it as the result, so the wizard printed
   * the platform's echo of the request. The rule: a value bound to a write call never reaches a
   * `set*` render setter. It must go through lib/verify-after-write.ts or lib/deploy-readback.ts,
   * which return what a fresh GET said.
   */
  it('never renders the response body of a write verb', () => {
    const offenders: string[] = [];
    // §5 carve-out: an enrollment token is a one-time secret that exists only in the create
    // response - no GET returns it - so the body is the resource, not an echo of the request.
    const oneTimeSecret = new Set(['pages/Nodes.tsx:153']);
    for (const [name, text] of sourceText()) {
      if (/\.test\./.test(name)) continue;
      // A5 states its scope as apps/platform-web/src/pages. The studio surface has its own two
      // hits (PipelineEditor.tsx:182 saves a draft from the PUT body; :269 is a computing POST,
      // /pipelines/preview, which writes nothing) - reported, not smuggled in as exempt here.
      if (name.split(/[\\/]/)[0] !== 'pages') continue;
      const bound = new Map<string, number>();
      text.split('\n').forEach((line, index) => {
        const inline = line.match(/\bset[A-Z]\w*\(\s*await\s+api\.(post|put|patch|delete)\b/);
        if (inline) offenders.push(name + ':' + (index + 1) + ' renders a write response inline');
        const m = line.match(/\b(?:const|let)\s+(\w+)\s*=\s*await\s+api\.(post|put|patch|delete)\b/);
        if (m && !oneTimeSecret.has(name + ':' + (index + 1))) bound.set(m[1], index + 1);
      });
      for (const [variable, line] of bound) {
        const rendered = new RegExp('\\bset[A-Z]\\w*\\(\\s*' + variable + '\\s*[,)]');
        if (rendered.test(text)) offenders.push(name + ':' + line + ' renders ' + variable + ' from a write response');
      }
    }
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
