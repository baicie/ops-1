#!/usr/bin/env node
/**
 * Phase 8A TASK-26: one sanitization boundary, so a secret cannot leave by a side door.
 *
 * THE DEFECT THIS REPLACES
 *
 * `collect-failure-evidence.mjs` redacted its `log.excerpt` and its
 * `lastPassingAssertion`, and then copied `classification.evidence[].line` verbatim
 * from the classifier's stdout. The classifier had been handed the RAW log. So the
 * same physical line appeared twice in one artifact - `<redacted-gh-token>` in the
 * excerpt and the live token in the evidence - because each field applied its own
 * rules, and one field applied none.
 *
 * Measured, on a fixture where the failing line is both the classifier's evidence
 * and the line carrying the secret:
 *
 *   classification.evidence.line  transfer failed for https://ghp_SENTINEL...@maven.example/x
 *   log.excerpt                   transfer failed for https://<redacted-gh-token>@maven.example/x
 *
 * Redaction applied field by field is redaction applied everywhere except the field
 * someone adds next. So this module is the ONLY place redaction happens, and it runs
 * over the whole serialised artifact rather than over named fields.
 *
 * THE ORDER, AND WHY IT IS THIS ORDER
 *
 *   Raw input -> parse -> classify -> CONSTRUCT evidence -> SANITIZE -> VALIDATE -> serialise
 *
 * Sanitising before construction would mean the classifier never sees the real
 * value, which changes what it classifies: `status: 429` redacted to
 * `<redacted numeric>` is a 429 nobody can find. Sanitising after construction
 * means the classifier keeps its semantics and nothing reaches a reader that has
 * not passed through one function.
 *
 * WHAT IT REDACTS, AND WHAT IT DOES NOT CLAIM
 *
 * Shapes and known values, never variable names alone: a secret in a log is a
 * VALUE. The list below covers the shapes this repository's own logs can produce
 * (GitHub tokens, bearer/basic auth, JWT, URL userinfo and query credentials,
 * Postgres URLs, AWS keys, PEM blocks, env-style assignments, JSON credential
 * fields, ANSI-wrapped secrets, and secrets that span lines).
 *
 * It does NOT claim to find an arbitrary unknown secret. A 12-character password
 * pasted into a debug line matches no shape and will survive. That limit is printed
 * in every artifact rather than left for a reader to discover - see `NOTICE`.
 *
 * `sanitize()` is applied to the ENTIRE serialised artifact, which is what makes
 * this a boundary rather than a convention: a new field is covered the moment it is
 * added, without anyone remembering to cover it.
 */

/**
 * The redaction rules, in order. Order matters in two places:
 *
 *   - the env-assignment rule must run before the generic key/value rule, or
 *     `PLUGIN_SECRET=abc` is caught by neither cleanly;
 *   - the PEM rule must run early, because its body is many lines of base64 that
 *     other rules would otherwise chew into fragments.
 */
const RULES = [
  {
    id: 'pem-private-key',
    what: 'a PEM private key block, including an encrypted one',
    re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
    to: '<redacted-pem-private-key>',
  },
  {
    id: 'github-token',
    what: 'a GitHub token by prefix (ghp/ghs/gho/ghu/ghr/github_pat)',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    to: '<redacted-gh-token>',
  },
  {
    id: 'jwt',
    what: 'a JSON Web Token (three dot-separated base64url segments, eyJ header)',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    to: '<redacted-jwt>',
  },
  {
    id: 'aws-secret',
    what: 'an AWS access key id',
    re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    to: '<redacted-aws-key>',
  },
  {
    id: 'url-userinfo',
    what: 'credentials in a URL userinfo section, for any scheme',
    // Any scheme, not just postgres: the registry, the gateway and the plugin
    // runtime all take URLs, and a token in one is the same leak as a token in
    // another. The username is kept - it is an identity, not a secret.
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    to: '$1$2:<redacted-url-password>@',
  },
  {
    id: 'url-query-credential',
    what: 'a credential carried in a query string (?token=, &sig=, &X-Amz-Signature=)',
    re: /([?&](?:token|access_token|api_?key|apikey|sig|signature|password|secret|X-Amz-Signature|X-Amz-Credential)=)[^&\s#"'<>]+/gi,
    to: '$1<redacted-query-value>',
  },
  {
    id: 'authorization-header',
    what: 'an Authorization header, Bearer or Basic',
    re: /\b(Authorization|Proxy-Authorization)\s*[:=]\s*(?:Bearer|Basic|Token|Digest)?\s*[A-Za-z0-9._~+/=-]{8,}/gi,
    to: '$1: <redacted-authorization>',
  },
  {
    id: 'bearer-bare',
    what: 'a bare Bearer token not preceded by the word Authorization',
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
    to: 'Bearer <redacted-bearer>',
  },
  {
    id: 'env-assignment',
    what: 'an env-style assignment whose NAME reads like a credential',
    // The NAME is the only place a variable name is used, and only to find the
    // VALUE. The value is what gets replaced.
    //
    // THE BARE VALUE MAY NOT CONTAIN A JSON DELIMITER. This function runs over a
    // SERIALISED artifact, so `SECRETTOKEN=abc` sits inside a JSON string followed
    // by a closing quote and a comma, and a `\S+` value group swallows the closing
    // quote, the comma and the start of the next field. Measured: the artifact
    // stopped being parseable JSON at exactly this rule, which is the worst possible
    // failure for a sanitizer - it corrupts the evidence it was meant to protect.
    //
    // So the bare branch excludes `"`, `,`, `}`, `]` and whitespace. A real secret
    // containing a quote or a comma is still caught by the quoted branches above and
    // by the value-shape rules, and the exclusion only shortens an over-eager match,
    // never extends one.
    re: /\b([A-Z0-9_]{0,60}(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL|AUTH)[A-Z0-9_]{0,60})\s*[=:]\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"',}\]]+)/g,
    to: '$1=<redacted-credential>',
  },
  {
    id: 'json-credential-field',
    what: 'a JSON/JS field named like a credential, by value only',
    re: /("(?:password|passwd|secret|token|apiKey|api_key|privateKey|private_key|credential|clientSecret|client_secret)"\s*:\s*)"(?:[^"\\]|\\.){4,}"/gi,
    to: '$1"<redacted-json-credential>"',
  },
  {
    id: 'cli-flag-credential',
    what: 'a credential passed as --token/--password/--api-key',
    re: /(--(?:token|password|passwd|secret|api-key|apikey|client-secret)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi,
    to: '$1<redacted-credential>',
  },
];

/**
 * ANSI escapes are stripped BEFORE the rules run.
 *
 * A secret printed in colour is still printed: `\x1b[31mghp_abc...\x1b[0m` does not
 * match `\bgh[pousr]_` because `\b` sees `m` then `g`, which is a word-to-word
 * boundary, and the escape's `[` breaks the token. Worse, a determined line can
 * interleave escapes INSIDE the token. Removing them first restores the shape the
 * rules were written against, and a reader does not need the colour bytes.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/**
 * @param {string} text
 * @param {{extraSecrets?: string[], extraRules?: Array}} [opts]
 *   `extraSecrets` are literal values known to be secret (an env var the caller
 *   holds). They are escaped and replaced first, longest-first, so a short secret
 *   cannot mask a longer one that contains it.
 * @returns {string}
 */
export function sanitizeText(text, opts = {}) {
  if (typeof text !== 'string') return text;
  let out = text.replace(ANSI, '');

  for (const secret of [...(opts.extraSecrets ?? [])].filter((s) => typeof s === 'string' && s.length >= 6).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('<redacted-known-secret>');
  }
  for (const rule of [...RULES, ...(opts.extraRules ?? [])]) out = out.replace(rule.re, rule.to);
  return out;
}

/**
 * Sanitise a whole artifact by walking its STRING VALUES, not by rewriting its
 * serialisation.
 *
 * The first version serialised the object, ran the rules over the JSON text, and
 * parsed back. It leaked nothing, and it broke the artifact: a rule's value group
 * (or a quoted branch) crossed a JSON delimiter, so
 *
 *   "line": "PLUGIN_SECRET=\"quoted value\""
 *
 * came back as `"line": "PLUGIN_SECRET=<redacted-credential>"quoted value\""` -
 * unparseable. A sanitizer that corrupts its own output is worse than one that
 * misses a secret, because bad JSON is silent in the direction that matters.
 *
 * Walking the values instead means every rule sees exactly the text a reader would
 * see, with no escaping to cross and no delimiters to swallow. The guarantee that
 * made the serialise-and-rewrite version attractive - "a field nobody has written
 * yet is covered" - is kept by the walk, which visits every string in every object
 * and array without knowing the schema.
 *
 * This is still one boundary: `sanitizeArtifact` is the only thing a caller calls,
 * and every string in the artifact passes through it.
 *
 * @template T
 * @param {T} artifact
 * @param {{extraSecrets?: string[]}} [opts]
 * @returns {T}
 */
export function sanitizeArtifact(artifact, opts = {}) {
  const walk = (node) => {
    if (typeof node === 'string') return sanitizeText(node, opts);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return node;
  };
  return walk(artifact);
}

/**
 * The limit, stated wherever the artifact is read. It is exported rather than
 * inlined so the tests can assert the artifact actually carries it.
 */
export const NOTICE =
  'redacted by value shape and by known secret value: GitHub tokens, bearer/basic auth, ' +
  'JWTs, URL userinfo and query credentials, Postgres/registry URLs, AWS key ids, PEM ' +
  'private keys, env-style credential assignments, JSON credential fields, CLI credential ' +
  'flags, and credentials split by ANSI escapes. A secret matching NO shape and not ' +
  'supplied as a known value is NOT redacted - this is a boundary, not a guarantee of ' +
  'completeness. Review before sharing outside the repository.';

/** The rule table, for the self-test and for documentation generation. */
export const RULE_TABLE = Object.freeze(RULES.map(({ id, what }) => ({ id, what })));

/**
 * A last-pass check, run on the FINAL serialised artifact: does any supplied
 * sentinel survive anywhere in it? Used by the tests (and available to a caller
 * that holds known secrets) as a fail-closed assertion.
 *
 * @param {string} serialised
 * @param {string[]} sentinels
 * @returns {string[]} the sentinels that survived
 */
export function findLeaks(serialised, sentinels) {
  return sentinels.filter((s) => s && serialised.includes(s));
}
