# ADR-025: Plugin version identity

**Status: PROPOSED — nothing here is implemented. TASK-05's brief requires an ADR
before a version-policy change, and forbids changing the plugin protocol
directly.**

Baseline: `scripts/publish-data-plugins.sh` as merged in #139 (`c3edae4`).

## The problem

The version is:

```bash
src_hash="$( { find ... -print0 | sort -z | xargs -0 cat; ... } | sha256sum | cut -c1-12 )"
version="0.0.$(( 0x$src_hash % 100000 ))"
```

Four separate concerns are collapsed into one five-digit number.

### 1. The collision domain is 100,000

`0x$src_hash % 100000` maps a 48-bit prefix onto 0..99,999. By the birthday
bound, a 50% collision probability is reached at roughly

```
sqrt(2 * 100000 * ln 2) ≈ 372 releases
```

This repository has published 0.0.x versions since the script was added. It is
not near 372 today. But the number is a **content fingerprint**, not a counter:
there is no ordering, so after a collision the "already installed" check below
sees a version that matches and skips the deploy, and the change never reaches
staging. Silently.

Recorded in the findings register under B-6, whose status is **NEEDS_DECISION**
(from #143 onwards; it read ACCEPTED_RISK only in the revision *before* this ADR
landed). This ADR proposes removing the risk rather than deciding about it.

### 2. Twelve hex characters is already lossy

`cut -c1-12` keeps 48 of 256 bits. That is fine against an *accidental* change
and fine against a *random* second preimage. It is not fine as an identity: if
the version is the thing that decides "is this the same artifact", then two
different source trees must not be able to produce the same version, and a
48-bit prefix gives a 2^-48 collision rate per pair — acceptable — on top of the
100,000-way modulo, which is not.

### 3. It does not answer the questions the deploy asks

The script asks "has this version been installed before?" - one of the many
existence questions it asks (it also checks that `plugins/` exists, that each
backend's `server.mjs` is present, that the registry serves the manifest, that
`RepoDigests` is non-empty). The point is narrower than "exactly one question":
**the one question about identity is answered by the version string alone.** The
platform has to answer several more, and the version cannot answer any of them:

| Question | Answerable today |
|---|---|
| Which source revision produced this bundle? | No |
| Which base image was it built on? | No |
| What is the artifact digest? | Yes, separately - but there are TWO digests, and they are different things: `bundle_digest` is the SHA-256 of the raw uploaded ZIP, `artifact_digest` is the SHA-256 of the canonical payload-index JSON (`crates/bundle/src/lib.rs:8-11`). Naming one of them "the artifact digest" is exactly the confusion this table is about. |
| Are two bundles with the same version the same bytes? | No |
| Can I roll back to "the one before this"? | Yes, the platform can: `kernel.activation_revisions` is totally ordered by `(plugin_id, generation)` with a unique index per plugin, and `opsctl rollback` takes an `--expected-revision`. The VERSION STRING cannot order, which is the actual point - the platform does not currently use the version for ordering, and should not start. |

### 4. What it DOES cover, after #139

Five paths, each verified to change the hash independently (an earlier draft
said "six" and listed five):

```
plugins/*/backend/*.mjs
plugins/*/backend/*.json
plugins/*/backend/Dockerfile
plugins/*/web/dist/**
plugins/*/manifest.template.json
```

That is five *globs*, more than five files. Note also what they do NOT cover: the
backend `package-lock.json` is a `*.json` under `backend/`, so it IS included -
but the paths themselves are not in the hashed stream (see the framing weakness
below).

## A framing weakness, checked rather than assumed

The hash command is:

```bash
find "$SRC"/plugins/*/backend -maxdepth 1 -type f \( -name '*.mjs' ... \) \
  -print0 | sort -z | xargs -0 cat
```

File **contents** are concatenated; file **names** are not in the stream. The
first claim I wrote here — that moving bytes between two files keeps the version
— is **false**, and I ran it before committing the claim:

```
server.mjs="ABC", config.json=""   -> b5d4045c3f46
server.mjs="AB",  config.json="C"  -> 362d88818ef2      (different)
```

`sort -z` orders by path, so changing which file holds which bytes changes the
READ order, and the concatenation differs. The version does change.

What remains true is narrower and still worth fixing: the hash is over contents
in path order, with **no length or path framing**. Two trees whose
path-ordered concatenations are byte-identical hash the same regardless of how
the boundaries fall:

```
a/x = "AB",  a/y = "C"     -> "ABC"
a/x = "A",   a/y = "BC"    -> "ABC"      SAME VERSION
```

This requires the differing content to land in the same path-ordered position,
so a real refactor almost never hits it — but "almost never" is the standard the
`BUILD_INFO`/`bundle_digest` fields were added to avoid, and a length prefix
costs one line. Not fixed here because it changes every version, which is a
staging event (decision 3 below).

## What is proposed

### Identity: keep it content-addressed, add a manifest

Do **not** introduce semantic versions for plugins. The brief's list —
Human-readable Version / Source Revision / Artifact Digest / OCI Digest /
Publisher Signature — is five *facts*, not five components of one string. Trying
to encode all of them in `version` is how the current design got into trouble.

Proposal: `version` stays the immutable content identity, and the bundle manifest
gains the facts as fields:

```json
{
  "version": "0.0.<sha256, Crockford base32, truncated to 26 chars>",
  "source_revision": "<git sha, or null>",
  "content_framing": "v2",
  "inputs": [
    {"path": "backend/server.mjs", "sha256": "..."},
    {"path": "backend/config.json", "sha256": "..."}
  ]
}
```

- **`version`**: the digest of a *framed* stream — each file contributes
  `path \0 length \0 content \0`. No modulo. Encoded as Crockford base32 and
  **truncated to 26 characters (130 bits)**, because the manifest schema caps the
  version at a SemVer triple: `^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$`
  (`contracts/schema/plugin-manifest.v1.schema.json:31`,
  `crates/contracts/src/lib.rs:543`). A full 256-bit digest is 52 characters and
  does NOT match that pattern, so the ADR cannot propose it without also
  proposing a schema change.

  130 bits is 1.5e-40 collision probability per pair - ample. The earlier draft
  of this section said "full sha256 ... 26 chars", which is self-contradictory:
  26 base32 chars is 130 bits, not 256.
- **`source_revision`**: recorded, never hashed. Including the git SHA in the
  identity would make two byte-identical artifacts from different commits
  different versions, which is wrong.
- **`content_framing`**: `v1` (today) or `v2`. **Required** so an old bundle is
  distinguishable from a new one without guessing.

### Why base32 and not a number

`0.0.<n>` reads like a version and behaves like a hash, and every reader has to
be told which. `0.0.<26 base32 chars>` is obviously not a counter, so nobody
orders by it.

The `0.0.` prefix is retained because every published v1 version already has the
form `0.0.<1..5 digits>` and those strings are immutable in the registry - **not**
because the schema already accepts a v2 shape. It does not:

```
contracts/schema/plugin-manifest.v1.schema.json:31
crates/contracts/src/lib.rs:543        (ManifestV11::validate)
crates/contracts/src/lib.rs:1028       (the re() cache)
  pattern: ^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$
```

`0.0.<26 base32 chars>` does not match it: the third SemVer component must be
digits. A base32 body passes only in the `-prerelease` slot
(`0.0.0-7Z3K9Q2M4X8B1C6D5E0F2G3H4JK`), or by the ~7e-14 chance that 26 base32
characters happen to be all digits. So landing v2 is a protocol change on
**those three sites plus `tests/ui/staging-smoke.spec.ts:82`**, not on the
registry's convenience.

### Compatibility — the part that decides whether this is safe

The kernel stores `version` as a string and compares it for equality. A v2
version does not equal any v1 version, so:

| Situation | Behaviour |
|---|---|
| v1 bundle already installed, v2 published | versions differ → install and deploy. This is correct and is the point. |
| rollback to a v1 bundle | its version is still its v1 string; the record is unchanged |
| two v2 bundles, same source | same version → "already installed", skipped. Correct. |
| a v1 and a v2 bundle of the same source | different versions → deployed twice. Wasteful, not wrong. |

The one rule that must hold: **nothing may compare a v1 and a v2 version for
ordering**. Nothing does today — the store is a string equality check — and this
ADR makes that an explicit constraint rather than an accident.

### The cutover

`content_framing` is how a reader tells which rule produced a version. A v1
version is `0.0.` + 1..5 digits; a v2 version is `0.0.` + 26 base32 chars. They
are distinguishable by length without the field, but the field is what a future
reader will trust, so it is written.

Existing bundles keep their v1 versions. Nothing is migrated; the registry
already holds those tags and republishing them under a new scheme would break
every pinned deployment.

## What is NOT proposed

- **No semantic versioning.** Deciding what "1.4.0" means for a plugin requires
  deciding the plugin/platform compatibility contract, which is a separate ADR
  and a much larger change.
- **No change to the OCI image tag scheme.** The image tag equals the version
  with no truncation (`scripts/publish-data-plugins.sh:135`); under v2 it would be
  a 30-character tag (`0.0.` + 26), which is legal and ugly.
  Keeping them equal is simpler than two schemes, so this ADR proposes keeping
  them equal and accepting the long tag.
- **No signature change.** The publisher signature already covers the bundle
  digest; nothing here alters what is signed.
- **No implementation in this round.** The change touches the publish script, the
  manifest schema, and every reader of `version`. It needs a compatibility
  window that only a real staging publish can exercise, and the brief forbids
  an unapproved staging publish.

## Decisions needed from a human

1. **base32 full digest, or a shorter readable prefix?** The proposal is the full
   digest; the cost is a 30-character image tag.
2. **Is `source_revision` wanted in the manifest?** It is useful for audit and
   costs nothing, but it means the publish script must know the git SHA — and it
   runs on the staging host, where the checkout may be a tarball.
3. **When can the framed-stream fix land?** It changes every version, so every
   plugin republishes once. That is a staging event and needs approval.
4. **Does the platform need ordering at all?** If a future feature wants "upgrade
   to the newest", a content hash cannot answer that - but the platform does not
   need a new field for it: `kernel.activation_revisions` is already totally
   ordered by `(plugin_id, generation)` with a unique index per plugin, and
   `opsctl rollback` already takes `--expected-revision`. The question is whether
   *plugins* need an ordering, not whether the platform can produce one. Better decided now than retrofitted.

## Reproduce

The framing weakness — a boundary shift with no length or path framing:

```bash
d=$(mktemp -d); mkdir -p "$d/a"
printf 'AB' > "$d/a/x"; printf 'C'  > "$d/a/y"
h1=$(find "$d/a" -maxdepth 1 -type f -print0 | sort -z | xargs -0 cat | sha256sum | cut -c1-12)
printf 'A'  > "$d/a/x"; printf 'BC' > "$d/a/y"
h2=$(find "$d/a" -maxdepth 1 -type f -print0 | sort -z | xargs -0 cat | sha256sum | cut -c1-12)
echo "$h1 / $h2"      # b5d4045c3f46 / b5d4045c3f46 — same
[ "$h1" = "$h2" ] && echo "CONFIRMED same version for different trees"
rm -rf "$d"
```

Run 2026-11-17: both `b5d4045c3f46`.

The claim this ADR originally made — that moving bytes BETWEEN files keeps the
version — was tested and is false (`b5d4045c3f46` vs `362d88818ef2`), because
`sort -z` changes the read order. It is recorded above rather than deleted, since
an ADR that only contains claims that survived is an ADR that did not check them.
