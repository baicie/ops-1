#!/usr/bin/env node
/**
 * Does the registry hold the digest we think it does? TASK-15.
 *
 * THE DEFECT THIS REPLACES
 *
 * `publish-data-plugins.sh:292` builds an image reference from the LOCAL
 * `docker inspect .RepoDigests`:
 *
 *     img="$REGISTRY/opsweave/$name@$(docker inspect ... | cut -d@ -f2)"
 *
 * That value is what the daemon recorded when it pushed. It says nothing about
 * what a puller will receive. If the push was partial, if the tag has since been
 * pointed elsewhere, or if the registry is simply wrong, the bundle still embeds
 * a digest that looks authoritative and is not - and the failure only appears
 * later, when a Node cannot pull it.
 *
 * WHAT THIS DOES
 *
 * Asks the REGISTRY, over the manifest API, what each reference resolves to, and
 * compares:
 *
 *   local  `docker inspect --format {{index .RepoDigests 0}}`  (what we think)
 *   remote `GET /v2/<repo>/manifests/<tag>` + Docker-Content-Digest  (what is)
 *
 * and refuses when they differ, when the tag does not exist, or when the registry
 * cannot be reached. Fail closed: an unanswerable question is not a pass.
 *
 * WHY NOT `docker manifest inspect`
 *
 * It is the obvious tool and it needs a Docker daemon plus registry credentials
 * in `~/.docker/config.json`. This runs in the publish path, where the daemon is
 * present but the credential file may not be, and a failure to authenticate would
 * be reported as "digest mismatch" - the wrong diagnosis. The plain manifest GET
 * needs only the registry URL.
 *
 * USAGE
 *
 *   node scripts/verify-registry-digest.mjs \
 *     --registry 127.0.0.1:15001 --repository opsweave/data-catalog \
 *     --tag 0.0.17455 --expect sha256:...
 *
 * Exits 0 only when the registry's answer equals `--expect`.
 */
import { execFileSync } from 'node:child_process';

/** The digest a registry reports for a tag, or null when it has no such tag. */
export function registryDigest({ registry, repository, tag, fetchImpl = globalThis.fetch }) {
  const url = `http://${registry}/v2/${repository}/manifests/${tag}`;
  // GET, not HEAD. Measured against a real `registry:2`: a HEAD request came back
  // `200` with `Content-Type: application/json` and NO `Docker-Content-Digest`,
  // so a HEAD-based reader concludes "the header is missing" for every tag. GET
  // returns the manifest and the header.
  return fetchImpl(url, {
    method: 'GET',
    headers: {
      // The manifest list is what a puller with a matching platform gets; the
      // single-arch media type is the fallback. Both are asked for because a
      // registry that stores one will 404 the other.
      accept: [
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json',
      ].join(', '),
    },
    signal: AbortSignal.timeout(15_000),
  }).then((response) => {
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`registry answered ${response.status} for ${repository}:${tag}`);
    }
    const digest = response.headers.get('docker-content-digest');
    if (!digest) {
      throw new Error(`registry answered without a Docker-Content-Digest header for ${repository}:${tag}`);
    }
    return digest;
  });
}

/** What the local daemon recorded for `ref`, or null. */
export function localDigest(ref, run = execFileSync) {
  try {
    const out = run('docker', ['inspect', '--format', '{{index .RepoDigests 0}}', ref], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const at = String(out).indexOf('@');
    return at === -1 ? null : String(out).slice(at + 1).trim();
  } catch {
    return null;
  }
}

/**
 * Decide whether a publish may proceed.
 *
 * @returns {{verdict: string, problems: string[]}}
 */
export function decide({ expected, remote, local }) {
  const problems = [];
  if (!expected) problems.push('no expected digest: refusing to verify nothing');
  if (remote === null) {
    problems.push('the tag does not exist in the registry; a push either did not happen or did not finish');
  } else if (remote && expected && remote !== expected) {
    problems.push(`the registry resolves the tag to ${remote}, not ${expected} - the tag points at different bytes`);
  }
  if (local && expected && local !== expected) {
    problems.push(`the local daemon recorded ${local}, not ${expected} - the bundle would embed a digest this host never pushed`);
  }
  let verdict;
  if (problems.length) verdict = 'REFUSED';
  else verdict = 'VERIFIED';
  return { verdict, problems };
}

// ---------------------------------------------------------------------------

function selftest() {
  const cases = [
    ['matching digests verify',
      decide({ expected: 'sha256:a', remote: 'sha256:a', local: 'sha256:a' }).verdict === 'VERIFIED'],
    ['a tag pointing elsewhere is refused',
      decide({ expected: 'sha256:a', remote: 'sha256:b', local: 'sha256:a' })
        .problems.some((p) => /points at different bytes/.test(p))],
    ['a missing tag is refused, not assumed',
      decide({ expected: 'sha256:a', remote: null, local: 'sha256:a' })
        .problems.some((p) => /does not exist/.test(p))],
    ['a local digest that was never pushed is refused',
      decide({ expected: 'sha256:a', remote: 'sha256:a', local: 'sha256:c' })
        .problems.some((p) => /never pushed/.test(p))],
    ['no expected digest is refused',
      decide({ expected: null, remote: 'sha256:a', local: null })
        .problems.some((p) => /verify nothing/.test(p))],
  ];
  let bad = 0;
  for (const [label, ok] of cases) {
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}\n`);
  }
  process.stdout.write(`registry digest selftest: ${cases.length - bad}/${cases.length}\n`);
  process.exit(bad === 0 ? 0 : 1);
}

const RUN_AS_PROGRAM = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (RUN_AS_PROGRAM) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--selftest') selftest();
  const arg = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? null : argv[i + 1]; };

  const registry = arg('registry');
  const repository = arg('repository');
  const tag = arg('tag');
  const expected = arg('expect');
  if (!registry || !repository || !tag || !expected) {
    process.stderr.write('usage: verify-registry-digest.mjs --registry H --repository R --tag T --expect sha256:...\n');
    process.exit(2);
  }

  let remote;
  try {
    remote = await registryDigest({ registry, repository, tag });
  } catch (error) {
    // An unreachable registry is not a mismatch. Saying so separately is what
    // stops an operator from chasing a digest bug that is a network fault.
    process.stdout.write(`verdict: REFUSED\n  the registry could not be asked: ${String(error).split('\n')[0]}\n`);
    process.exit(1);
  }
  const local = localDigest(`${registry}/${repository}:${tag}`);
  const { verdict, problems } = decide({ expected, remote, local });
  process.stdout.write(`expected: ${expected}\nremote:   ${remote ?? '(tag absent)'}\nlocal:    ${local ?? '(not in this daemon)'}\n`);
  for (const p of problems) process.stdout.write(`  ${p}\n`);
  process.stdout.write(`verdict: ${verdict}\n`);
  process.exit(verdict === 'VERIFIED' ? 0 : 1);
}
