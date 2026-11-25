# Phase 8A — failure diagnosis you can trust

Baseline `main b217284a`. Three tools changed: `classify-failure.mjs` (V2),
`collect-failure-evidence.mjs` (V2), and a new shared boundary
`lib/evidence-sanitize.mjs` plus `lib/evidence-budget.mjs`.

The rule this wave is built on is the brief's own: **prove the gap first, then fix
it.** Every defect below was reproduced before any code changed, and every repro is
now a committed fixture.

---

## TASK-26 (P0): the sanitization bypass

### The defect, reproduced

The collector redacted `log.excerpt` and `lastPassingAssertion`, and copied
`classification.evidence[].line` **verbatim** from the classifier's stdout. The
classifier had been handed the raw log. So one physical line appeared twice in one
artifact:

```
classification.evidence.line   transfer failed for https://ghp_SENTINEL...@maven.example/x
log.excerpt                    transfer failed for https://<redacted-gh-token>@maven.example/x
```

That is what redaction applied field-by-field always produces: redaction everywhere
except the field someone adds next.

### The fix

One module, `tests/ci/lib/evidence-sanitize.mjs`, and one entry point a caller uses:
`sanitizeArtifact`. It walks every string in the artifact — no schema knowledge, so
a field added tomorrow is covered — and applies value-shape rules plus any
known-secret values the caller supplies.

The order is **construct → sanitize → validate → serialise**. Sanitising earlier
would change what the classifier sees: `status: 429` redacted to `<redacted numeric>`
is a 429 nobody can find. The input is also pre-sanitised, so the value never enters
the process at all; that is safe because no rule touches a digit, an HTTP status or
the word `FAIL`, and the test asserts the verdicts are unchanged.

### Two defects found **in the fix itself**

Both were caught by writing the test, and both are recorded because they are the
kind that would have shipped:

1. **The sanitizer broke the artifact it sanitised.** `sanitizeArtifact` serialised
   the object, ran the rules over the JSON text, and parsed back. The env-assignment
   rule's bare-value branch used `\S+`, which crossed the closing quote and the comma
   between two fields:

   ```
   "line": "PLUGIN_SECRET=\"quoted value\""   ->   "line": "PLUGIN_SECRET=<redacted-credential>"quoted value\""
   ```

   Unparseable. A sanitizer that corrupts its own output is worse than one that
   misses a secret, because broken JSON is caught loudly and a mangled field is not.
   Fixed by walking **string values** rather than the serialisation, which also
   removed the escaping problem entirely.

2. **`--redact-only` ignored `OPSWEAVE_EVIDENCE_SENTINELS`.** The known-secret
   channel is the only one that catches a value matching no shape, and the mode a
   caller uses to test that channel did not accept it.

### Shapes covered, and the limit

GitHub tokens (`ghp/ghs/gho/ghu/ghr/github_pat`), bearer and basic `Authorization`,
bare `Bearer`, JWT, AWS key ids, URL userinfo (any scheme), URL query credentials,
PEM private key blocks, env-style assignments, JSON credential fields, CLI credential
flags, and secrets split by ANSI escapes (stripped first, which is what makes a
coloured token match at all).

**It does not claim to find an arbitrary unknown secret.** A twelve-character
password pasted into a debug line matches no shape and survives. That is printed in
every artifact via `NOTICE`, not left for a reader to discover.

---

## TASK-27 (P1): why V1's answer was confidently wrong

### The character-class bug

```js
const isFailureLine = (l) => /[\[FATAL\]|\[ERROR\]|...]/.test(l);
```

That is not an alternation. It is a **character class**, and it matches every
string:

```
"everything is fine" -> true     "PASS" -> true     "ok" -> true
```

Every "prefer a failure line as evidence" decision since the file was written
returned `matches[0]`. The rule had never done anything.

### The four counterexamples, reproduced

| | V1 said | correct |
|---|---|---|
| A | `EXTERNAL_DEPENDENCY`, quoting a **recovered** 429 | the assertion failure after it |
| B | `EXTERNAL_DEPENDENCY` from a job the API reports **SUCCEEDED** | the crash in the other job |
| C | `STAGING_ENVIRONMENT`, quoting a **PASSING** assertion's text | `PRODUCT_REGRESSION` |
| D | one category for two matrix rows failing differently | two findings |

### The three layers

```
Layer 1  OBSERVATION  which jobs/steps failed, from the API conclusions.
                      A log cannot disagree with itself about an exit code; the API
                      can be MISSING, and that is reported as `degraded`, not guessed.
Layer 2  SIGNAL       every candidate signature, with its job, step, line and whether
                      it RECOVERED. No filtering.
Layer 3  ATTRIBUTION  one finding per failed step. A signal in a step that succeeded
                      cannot explain another step's failure. A recovered signal is
                      reported and demoted, never promoted.
```

Two things this refuses to do, both load-bearing:

- **It will not call an assertion failure a product defect.** Three verdict kinds
  are separate: `assertion_failure_observed`, `product_defect_confirmed`,
  `harness_defect_confirmed`. Only the first is visible in a log. Telling the other
  two apart means reading the assertion against its specification, which is a
  judgement. The output says what would confirm each.
- **It will not collapse two failures into one cause.** A single cause is one
  finding; different causes stay different findings, and the human output says so.

### The exit code is part of the contract

```
0  nothing to classify — the run concluded SUCCESS and no failure was observed
1  a failure was observed and nothing named its cause
2  a failure was observed and attributed
```

The first version exited 0 whenever every finding had a category — so a perfectly
attributed `PRODUCT_REGRESSION` returned 0. A shell caller checking `if classify;
then` read "the classification worked" as "there is no problem". A diagnostic that
exits 0 on a failure is a diagnostic that will one day be used as a gate that passes.

### Backward compatibility

The seven V1 categories are unchanged, and `verdict` / `confidence` / `reason` /
`evidence` remain at the top level, derived from `findings[0]`. A consumer that read
only `verdict` keeps working. `findings[]` is where the additional information
lives, and the human output prints all of it.

---

## TASK-28 (P1): evidence attributed to a job and an attempt

V1 found the first failure line in the whole log and hung the entire artifact off
it. Three measured consequences:

- a matrix job failing on capacity and a job failing on an assertion produced **one**
  classification, and it was the capacity one;
- `run_attempt` was recorded but never **pinned**, so a re-run landing mid-collection
  could mix two attempts' jobs into one coherent-looking artifact;
- `tryGh` returned the error text as though it were the response body, so a 403
  became `JSON.parse('gh: Resource not accessible') || '{}'` → `{}` → **"no jobs"**.

The model is now `Run → Attempt → Job → Step → Log Range`, with:

- the attempt pinned from the run object before anything else is fetched, and
  carried on every failed job;
- a log range scoped to each failed step's prefix, so one job's excerpt cannot
  contain another's lines;
- `completeness` as a **field**: `COMPLETE` / `PARTIAL` / `UNAVAILABLE`, with a
  reason. An API error never becomes an empty list — and an empty `failedJobs`
  adjacent to a complete status is the exact sentence V1 produced;
- lines with no tab prefix kept at run level in `unattributedLines`, rather than
  assigned to whichever job was seen last.

---

## TASK-29: the budget, in bytes

V1 checked `Buffer.byteLength(excerpt)` and then cut with `excerpt.slice(0, MAX_BYTES)`.
`slice` counts UTF-16 code units:

- 1000 CJK characters are 1000 units and **3000** bytes, so a "512 KB" artifact is
  1.5 MB on disk — the cap is not the cap;
- slicing an arbitrary unit splits surrogate pairs: `"aaaaaaaaaa😀bbb"` cut to 11
  ends in a lone `\ud83d`, which no reader can decode back.

`lib/evidence-budget.mjs` truncates on the UTF-8 byte stream and always lands on a
character boundary (verified for every cap from 0 to 400 across CJK, emoji and mixed
text). `fitBudget` degrades in a fixed order, and the order encodes one rule —
**structure is never sacrificed for detail**:

1. shorten excerpts to the room available (keeping a readable prefix),
2. shorten evidence lines to 160 bytes,
3. drop `lastPassingAssertion` (context, not evidence),
4. if the skeleton alone is over budget, say so in `completeness` and exceed the
   budget rather than dropping a failed job.

Every reduction is recorded in `omissions`, with byte counts, and `truncation`
carries `bytes`, `maxBytes` and `droppedBytes`.

---

## What is verified, and what is not

Verified, offline, no `gh` credentials:

```
bash tests/ci/evidence-sanitize.test.sh            17 assertions
bash tests/ci/classify-failure.test.sh             28 assertions   (10 fixtures)
bash tests/ci/collect-failure-evidence.test.sh     19 assertions
```

**Not verified:** the live `--run` path. It shares every line of post-processing
with `--from-json` — there is exactly one `const collected = {` — but the fetch
itself (attempt-pinned endpoint, fallback, 403/429 handling) has only been exercised
against fixtures shaped like real responses, not against GitHub. That is a real
limit and is not claimed otherwise.

**Not covered:** the case where a real secret matches no shape AND is not supplied
as a known value. Stated in `NOTICE` and here.

---

## The pattern worth keeping

This wave found three defects in code that was already merged and already tested:
a redaction boundary with a hole, a classifier whose "prefer failure lines" rule
had never worked, and a byte cap applied in characters. All three passed their
existing tests. The tests asserted that output existed, not that it was **right**.

The fix that generalises is the one used here: for each, write the counterexample
as a fixture **first**, watch it fail, then change the code until it passes — and
keep the fixture, so the next person cannot regress it silently.
