#!/usr/bin/env node
/**
 * A YAML subset parser for GitHub workflow files, with explicit failure.
 *
 * WHY NOT A YAML LIBRARY
 *
 * Three tools in this repository read workflow YAML (`workflow-snapshot.mjs`,
 * `check-paths-filters.mjs`, `check-impact-consistency.mjs`) and each had its
 * own hand-rolled reader. They disagreed: `parseTriggers` stopped at the first
 * comment line inside a `paths:` list, so `g12-acceptance.yml` reported 6
 * trigger paths when it has more, and `data-foundation.yml` reported 2.
 *
 * A general YAML library would fix the parsing and introduce two problems this
 * repository cannot accept:
 *
 *   - YAML 1.1 turns the key `on` into the boolean `true`. The `on:` key is the
 *     single most important key in a workflow, and a library that silently
 *     renames it is worse than a parser that knows it is a subset.
 *   - `${{ ... }}` expressions must be preserved verbatim. A library that
 *     resolves or normalises them loses the thing being compared.
 *
 * So this parses the subset GitHub workflows actually use, and REFUSES on
 * anything outside it. `parse()` returns `{ ok: false, error }` rather than
 * guessing; every caller decides what a refusal means, and none of them may
 * treat it as "no findings".
 *
 * WHAT IT UNDERSTANDS
 *
 *   block mappings and sequences by indentation
 *   inline flow sequences  [a, b]
 *   block scalars          | and > with their chomping indicators
 *   quoted and plain scalars, with `#` comments stripped when unquoted
 *   `key:` with no value, followed by a nested block
 *
 * WHAT IT REFUSES, BY THROWING A LocatedError
 *
 *   tabs in indentation (YAML forbids them; a silent re-interpretation would
 *   change nesting)
 *   a line indented more than its parent allows when no block is open
 *   anchors, aliases, tags, flow mappings `{a: b}` (none appear in this
 *   repository's workflows, and supporting them badly is worse than refusing)
 *
 * The refusal is the feature: a checker that quietly returns a partial tree is
 * how `g12-acceptance.yml` came to look like it had six trigger paths.
 */

class LocatedError extends Error {
  constructor(message, line) {
    super(`${message} (line ${line})`);
    this.name = 'LocatedError';
    this.line = line;
  }
}

const isBlank = (s) => s.trim() === '';
const isComment = (s) => /^\s*#/.test(s);

/** Strip a trailing ` # comment` from an unquoted scalar. */
function stripComment(value) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value.trimEnd();
}

/** Unquote a scalar. `${{ }}` inside quotes survives untouched. */
function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1);
  }
  return v;
}

/** Parse `[a, b, 'c']` into an array. */
function parseFlowSequence(value) {
  const inner = value.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (inner.trim() === '') return [];
  return inner.split(',').map((s) => unquote(stripComment(s)));
}

/** Parse `{a: b, c: d}` into an object. Values are scalars only. */
function parseFlowMapping(value) {
  const inner = value.trim().replace(/^\{/, '').replace(/\}$/, '');
  const out = {};
  if (inner.trim() === '') return out;
  for (const part of inner.split(',')) {
    const kv = splitKey(part.trim());
    if (!kv) throw new LocatedError(`cannot parse inline mapping entry ${JSON.stringify(part.trim())}`, 0);
    out[kv.key] = unquote(stripComment(kv.rest));
  }
  return out;
}

/** Split `key: value` at the first top-level colon. */
function splitKey(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ':' && !inSingle && !inDouble) {
      // A colon only ends a key when followed by space or end of line.
      if (i === line.length - 1 || /\s/.test(line[i + 1])) {
        return { key: unquote(line.slice(0, i).trim()), rest: line.slice(i + 1).trim() };
      }
    }
  }
  return null;
}

/**
 * Parse a document into plain objects/arrays/scalars.
 *
 * @param {string} text
 * @returns {{ok: true, value: unknown} | {ok: false, error: string, line: number}}
 */
export function parse(text) {
  try {
    return { ok: true, value: parseDocument(text) };
  } catch (error) {
    if (error instanceof LocatedError) {
      return { ok: false, error: error.message.replace(/ \(line \d+\)$/, ''), line: error.line };
    }
    return { ok: false, error: String(error), line: 0 };
  }
}

function parseDocument(text) {
  const raw = text.split('\n');
  /** Significant lines: [indent, content, lineNumber] with comments and blanks dropped. */
  const lines = [];
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i];
    if (isBlank(line) || isComment(line)) continue;
    const indentMatch = /^[ \t]*/.exec(line)[0];
    if (indentMatch.includes('\t')) {
      throw new LocatedError('tab in indentation; YAML does not allow tabs here', i + 1);
    }
    lines.push({ indent: indentMatch.length, content: line.slice(indentMatch.length).replace(/\s+$/, ''), line: i + 1 });
  }
  if (lines.length === 0) return null;

  let cursor = 0;

  const peek = () => lines[cursor];
  const next = () => lines[cursor++];

  /**
   * Parse a block starting at the current cursor with indentation >= `indent`.
   * A sequence if the first meaningful line starts with `- `, otherwise a map.
   */
  function parseBlock(indent) {
    const first = peek();
    if (!first) return null;
    if (first.content === '-' || first.content.startsWith('- ')) return parseSequence(first.indent);
    return parseMapping(first.indent);
  }

  function parseSequence(indent) {
    const out = [];
    while (peek() && peek().indent === indent && (peek().content === '-' || peek().content.startsWith('- '))) {
      const item = next();
      const rest = item.content === '-' ? '' : item.content.slice(2).trim();
      if (rest === '') {
        // The value is the following block, indented deeper.
        const child = peek();
        out.push(child && child.indent > indent ? parseBlock(child.indent) : null);
        continue;
      }
      // `- key: value` starts a mapping whose keys are on this line and the next
      // lines indented by indent+2.
      const kv = splitKey(rest);
      if (kv) {
        const obj = {};
        applyKey(obj, kv, indent + 2);
        // More keys of the same mapping follow at indent+2.
        while (peek() && peek().indent === indent + 2 && !peek().content.startsWith('- ')) {
          const more = next();
          const mkv = splitKey(more.content);
          if (!mkv) throw new LocatedError(`expected "key: value" after a sequence item, found ${JSON.stringify(more.content)}`, more.line);
          applyKey(obj, mkv, indent + 2);
        }
        out.push(obj);
        continue;
      }
      out.push(unquote(stripComment(rest)));
    }
    return out;
  }

  function parseMapping(indent) {
    const out = {};
    while (peek() && peek().indent === indent) {
      const line = next();
      if (line.content.startsWith('- ')) {
        throw new LocatedError('sequence item where a mapping key was expected', line.line);
      }
      const kv = splitKey(line.content);
      if (!kv) throw new LocatedError(`expected "key: value", found ${JSON.stringify(line.content)}`, line.line);
      applyKey(out, kv, indent);
    }
    return out;
  }

  /**
   * Assign one `key: rest` pair into `obj`, consuming any nested block.
   *
   * `keyIndent` is the indentation of the key itself; a nested block must be
   * deeper than it.
   */
  function applyKey(obj, { key, rest }, keyIndent) {
    if (rest === '') {
      const child = peek();
      obj[key] = child && child.indent > keyIndent ? parseBlock(child.indent) : null;
      return;
    }
    // A block scalar: `|`, `|-`, `>`, `>-`.
    const blockScalar = /^([|>])([+-]?)(\d?)$/.exec(rest);
    if (blockScalar) {
      const [style, chomp] = [blockScalar[1], blockScalar[2]];
      const collected = [];
      const baseIndent = peek() ? peek().indent : keyIndent + 2;
      while (peek() && peek().indent >= baseIndent) {
        collected.push(next().content);
      }
      let value = collected.join(style === '|' ? '\n' : ' ');
      if (chomp !== '-') value += '\n';
      obj[key] = value;
      return;
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      obj[key] = parseFlowSequence(rest);
      return;
    }
    if (rest.startsWith('{') && rest.endsWith('}')) {
      // Inline mapping: `with: { node-version: 22, cache: pnpm }`. It appears in
      // six of this repository's workflows, so refusing it would make the parser
      // unusable - the point of refusing is to fail on constructs nobody has
      // reviewed, not on the ones in daily use.
      obj[key] = parseFlowMapping(rest);
      return;
    }
    if (/^[[{]/.test(rest)) {
      throw new LocatedError(`unbalanced flow collection: ${rest}`, 0);
    }
    if (/^[&*!]/.test(rest)) {
      throw new LocatedError(`anchors, aliases and tags are not supported: ${rest}`, 0);
    }
    obj[key] = unquote(stripComment(rest));
  }

  const value = parseBlock(lines[0].indent);
  if (cursor < lines.length) {
    throw new LocatedError(`unparsed content at ${JSON.stringify(lines[cursor].content)}`, lines[cursor].line);
  }
  return value;
}

export { LocatedError };
