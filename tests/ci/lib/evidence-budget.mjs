#!/usr/bin/env node
/**
 * Phase 8A TASK-29: a budget measured in BYTES, not in JavaScript characters.
 *
 * THE DEFECT THIS REPLACES
 *
 * The collector capped its excerpt with
 *
 *   if (Buffer.byteLength(excerpt) > MAX_BYTES) excerpt = excerpt.slice(0, MAX_BYTES)
 *
 * The test measured bytes; the slice cut characters. Two things follow, and both
 * were reproduced:
 *
 *   - `String.prototype.slice` counts UTF-16 code units. 1000 CJK characters are
 *     1000 units and 3000 bytes, so a "512 KB" artifact holding Chinese or emoji
 *     log text is 1.5 MB on disk, and the cap is not the cap.
 *   - slicing at an arbitrary unit can split a surrogate pair. `"aaaaaaaaaa😀bbb"`
 *     sliced to 11 units ends in a lone `\ud83d`, which `JSON.stringify` writes as
 *     `\ud83d` and which no reader can decode back to a character. The artifact is
 *     still parseable JSON and is no longer the log.
 *
 * So truncation here is defined on the UTF-8 byte stream and always lands on a
 * character boundary: a cut never produces an invalid sequence and never emits a
 * replacement character.
 */

/**
 * UTF-8 byte length of a string, without allocating the buffer when the string is
 * short enough that `Buffer.byteLength` is the cheapest correct answer anyway.
 * @param {string} s
 * @returns {number}
 */
export function byteLength(s) {
  return Buffer.byteLength(s, 'utf8');
}

/** True when `b` is a UTF-8 continuation byte (10xxxxxx). */
const isContinuation = (b) => (b & 0xc0) === 0x80;

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes, ending on a character
 * boundary. Returns the string unchanged when it already fits - callers use the
 * `truncated` flag rather than comparing lengths.
 *
 * @param {string} s
 * @param {number} maxBytes
 * @returns {{text: string, bytes: number, originalBytes: number, truncated: boolean}}
 */
export function truncateUtf8(s, maxBytes) {
  const originalBytes = byteLength(s);
  if (originalBytes <= maxBytes) {
    return { text: s, bytes: originalBytes, originalBytes, truncated: false };
  }
  if (maxBytes <= 0) return { text: '', bytes: 0, originalBytes, truncated: true };

  // Cut the buffer, then walk BACK off any partial sequence. Walking back is
  // enough: UTF-8 has no sequence longer than 4 bytes, so at most 3 steps.
  const buf = Buffer.from(s, 'utf8');
  let end = maxBytes;
  let guard = 0;
  while (end > 0 && end < buf.length && isContinuation(buf[end]) && guard < 4) {
    end -= 1; guard += 1;
  }
  const text = buf.subarray(0, end).toString('utf8');
  return { text, bytes: Buffer.byteLength(text, 'utf8'), originalBytes, truncated: true };
}

/**
 * Shrink an artifact until its SERIALISED form fits `maxBytes`, recording every
 * reduction in `omissions` so a reader knows what is missing rather than inferring
 * it from a short file.
 *
 * The order of sacrifice is deliberate, and it follows one rule: **structure is
 * never sacrificed for detail.**
 *
 *   1. log excerpts (largest, most redundant with the source)
 *   2. per-signal evidence text (re-readable from the source)
 *   3. the last passing assertion (a convenience, not evidence)
 *   4. the excerpt's own tail
 *
 * Failed jobs, their ids, their failed steps, and every classification survive at
 * every step. A truncated artifact that has lost the list of failed jobs is worse
 * than no artifact, because it reads as "one job failed".
 *
 * If the skeleton alone does not fit, that is reported as `PARTIAL` with the reason
 * - the function never silently drops a failed job to make the number work.
 *
 * @param {object} artifact
 * @param {number} maxBytes
 * @param {{serialise?: (o: object) => string}} [opts]
 * @returns {{artifact: object, serialised: string, bytes: number, truncated: boolean, omissions: string[]}}
 */
export function fitBudget(artifact, maxBytes, opts = {}) {
  const serialise = opts.serialise ?? ((o) => JSON.stringify(o, null, 2));
  const omissions = [];

  let out = structuredClone(artifact);
  let text = serialise(out);
  let bytes = byteLength(text);
  if (bytes <= maxBytes) return { artifact: out, serialised: text, bytes, truncated: false, omissions };

  const refit = () => { text = serialise(out); bytes = byteLength(text); return bytes; };

  // 1. Shorten log excerpts to whatever room is left, largest first. The excerpt
  //    is a convenience view of a source that still exists, so it is the first
  //    thing to give up bytes - but not the first thing to give up entirely. An
  //    artifact with the header of the failing log region is more useful than one
  //    with none of it, and the earlier version of this function jumped straight
  //    to "removed" and lost the failure context to save 300 bytes of metadata.
  if (refit() > maxBytes) {
    const excerpts = [];
    const collect = (node) => {
      if (!node || typeof node !== 'object') return;
      if (typeof node.excerpt === 'string' && node.excerpt.length) excerpts.push({ node, bytes: byteLength(node.excerpt) });
      for (const v of Object.values(node)) collect(v);
    };
    collect(out);
    let dropped = 0;
    for (const e of excerpts.sort((a, b) => b.bytes - a.bytes)) {
      if (bytes <= maxBytes) break;
      // Reclaim enough to land under budget, but always leave a readable prefix.
      const overflow = bytes - maxBytes;
      const room = Math.max(0, e.bytes - overflow - 256);
      const r = truncateUtf8(e.node.excerpt, room);
      dropped += e.bytes - byteLength(r.text);
      e.node.excerpt = r.text;
      e.node.excerptTruncated = r.truncated;
      e.node.excerptBytes = byteLength(r.text);
      refit();
    }
    if (dropped) omissions.push(`log excerpts shortened by ${dropped} bytes to meet the ${maxBytes}-byte budget; the source log is unchanged`);
    // Only if still over: drop them.
    if (bytes > maxBytes) {
      for (const e of excerpts) {
        if (e.node.excerpt) { e.node.excerpt = ''; e.node.excerptOmitted = true; }
      }
      omissions.push('log excerpts removed entirely; the budget was exceeded by the skeleton plus any excerpt');
      refit();
    }
  }

  // 2. Shorten per-signal evidence lines to a fixed prefix. Keep the prefix rather
  //    than dropping the line: a reader can still see which signature matched.
  if (bytes > maxBytes) {
    let shortened = 0;
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node.evidence)) {
        for (const e of node.evidence) {
          if (e && typeof e.line === 'string' && byteLength(e.line) > 160) {
            const r = truncateUtf8(e.line, 160);
            shortened += byteLength(e.line) - byteLength(r.text);
            e.line = r.text;
            e.lineTruncated = true;
          }
        }
      }
      for (const v of Object.values(node)) walk(v);
    };
    walk(out);
    omissions.push(`evidence lines shortened to 160 bytes (${shortened} bytes dropped)`);
    refit();
  }

  // 3. The last passing assertion is context, not evidence: it goes before anything
  //    that names what failed.
  if (bytes > maxBytes && typeof out.lastPassingAssertion === 'string') {
    const dropped = byteLength(out.lastPassingAssertion);
    omissions.push(`lastPassingAssertion removed to meet the budget (${dropped} bytes)`);
    out.lastPassingAssertion = null;
    refit();
  }

  // 4. Still too big: the skeleton itself is oversized. Report it, do not drop
  //    failed jobs.
  if (bytes > maxBytes) {
    out.completeness = {
      status: 'PARTIAL',
      reason: `the artifact skeleton alone is ${bytes} bytes, over the ${maxBytes}-byte budget; ` +
        'no failed job or classification was dropped, so the file is larger than the budget rather than incomplete',
    };
    refit();
  }

  return { artifact: out, serialised: text, bytes, truncated: true, omissions };
}
