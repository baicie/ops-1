#!/usr/bin/env bash
# Build, sign and install the Data Foundation plugin bundles on the staging host.
#
# RUN THIS ON THE HOST. It is scp'd there by
# .github/workflows/staging-preview.yml, which is the only caller.
#
# WHY THIS IS A FILE AND NOT AN `ssh '...'` ONE-LINER
#
# It was a one-liner first. The nested `$( ... )` and `( ... )` inside a
# single-quoted remote command broke it twice:
#
#   bash: -c: line 35: unexpected EOF while looking for matching `)'
#
# A script that travels as a file can be syntax-checked (`bash -n`) before it is
# sent, and its errors point at line numbers in this file instead of at a line
# inside a YAML string.
#
# WHAT IT DOES, in order
#
#   1. Derives a version from everything the bundle carries - backend modules AND
#      the web dist. A UI-only change must produce a new version, or the
#      "already installed" check below skips it and the plugin keeps serving the
#      old front end.
#   2. Builds both plugin images on this host (linux/amd64 natively) and pushes
#      them to the local registry.
#   3. Assembles, signs and installs a bundle per plugin, inside the kernel
#      container - the only place `opsctl` exists.
#
# THE PUBLISHER KEY MUST BE REGISTERED, NOT MERELY CREATED
#
# A bundle signed by a key the platform has not trusted is refused with
# SIGNATURE_OR_BUNDLE_INVALID, which is what the first run that got this far
# returned. Creating the key is half the job; the platform has to know its public
# half.
#
# So after creating the key, this registers the public half as `trusted-team` -
# the publisher id the manifests already declare - through the platform's own
# admin API. That upserts, so a host whose key is already registered is
# unaffected, and a rotated key registers itself instead of silently mismatching.
#
# This is a deliberate write to trust state, and the reason it is here rather
# than in a manual step: a deployment that can publish a bundle but cannot
# register the key that signs it has a path that only works once, by hand. If you
# do not want the deployment to own this, set PUBLISHER_ID to a publisher that is
# registered out of band and provision $PUBLISHER_KEY yourself.
set -euo pipefail

SRC="${PLUGIN_SRC:-/srv/opsweave-staging/plugin-src}"
DATA="${DATA_DIR:-/srv/opsweave-staging}"
KERNEL_CONTAINER="${KERNEL_CONTAINER:-opsweave-staging-kernel-1}"
PG_CONTAINER="${PG_CONTAINER:-opsweave-staging-postgres-1}"
PG_USER="${PG_USER:-opsweave}"
PG_DB="${PG_DB:-opsweave}"
REGISTRY="${PLUGIN_REGISTRY:-127.0.0.1:15001}"
KERNEL_URL="${KERNEL_URL:-http://127.0.0.1:3000}"
PUBLISHER_KEY="$DATA/publisher.key"
PUBLISHER_PUB="$DATA/publisher.pub"
PLUGINS=(data-catalog data-integration)

say() { printf '%s\n' "$*"; }
die() { printf '::error::%s\n' "$*" >&2; exit 1; }

# The publisher private key must not outlive this script inside the kernel
# container. It used to be removed at the end of the loop, which is a line that
# `set -e` skips whenever `bundle`, `install` or `deploy` fails - so the exit
# path that most needs the cleanup was the one that never reached it. The key
# then sat in a long-running container at /tmp/publisher.key until the next
# deploy recreated it.
#
# The trap runs on success, failure, SIGINT and SIGTERM. It is deliberately
# narrow: one known path inside one known container, not a sweep - this script
# does not own anything else in there.
KEY_IN_CONTAINER=0
cleanup() {
  local rc=$?
  if [ "$KEY_IN_CONTAINER" = "1" ]; then
    if sudo docker exec "$KERNEL_CONTAINER" rm -f /tmp/publisher.key 2>/dev/null; then
      KEY_IN_CONTAINER=0
    else
      # Say so rather than exiting quietly: a key left behind is a fact the
      # operator has to know about, and a silent success would hide it.
      printf '::error::could not remove /tmp/publisher.key from %s; the publisher private key may still be in that container\n' \
        "$KERNEL_CONTAINER" >&2
    fi
  fi
  # The staging copies are not secret material (assembled manifests), but a
  # failed run should not leave half-built trees either.
  sudo rm -rf /tmp/opsweave-bundle-* 2>/dev/null || true
  return "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[ -d "$SRC/plugins" ] || die "no plugin source at $SRC"
for name in "${PLUGINS[@]}"; do
  [ -f "$SRC/plugins/$name/web/dist/remoteEntry.js" ] \
    || die "plugins/$name/web/dist/remoteEntry.js is missing; the bundle would ship without a UI"
  [ -f "$SRC/plugins/$name/backend/server.mjs" ] \
    || die "plugins/$name/backend/server.mjs is missing"
done

# --- 1. version -------------------------------------------------------------
# Everything the bundle carries, so a UI-only change is a new version. `sort`
# keeps the hash stable across filesystem ordering.
# Everything that changes what the bundle CONTAINS.
#
# A version that ignores some inputs is worse than no version: the deploy sees
# the same version, concludes the plugin is already installed, and skips it - so
# the change is never published, and nothing reports a problem.
#
# The first version of this hashed only `backend/*.mjs` and the web dist. Editing
# `manifest.template.json` (the capabilities a plugin declares), the Dockerfile
# (how its image is built) or its lockfile (what it runs) all produced the SAME
# version, and the "already installed" check below would then keep serving the
# old plugin forever.
#
# What is deliberately NOT here: the registry host, the build date, the git SHA.
# Those change without changing the artifact, and including them would make every
# deploy publish a new version of an unchanged plugin.
src_hash="$(
  {
    find "$SRC"/plugins/*/backend -maxdepth 1 -type f \( -name '*.mjs' -o -name '*.json' -o -name 'Dockerfile' \) \
      -print0 | sort -z | xargs -0 cat
    find "$SRC"/plugins/*/web/dist -type f -print0 | sort -z | xargs -0 cat
    cat "$SRC"/plugins/*/manifest.template.json
  } | sha256sum | cut -c1-12
)"
version="0.0.$(( 0x$src_hash % 100000 ))"
say "plugin source digest: $version (from $src_hash)"

# --- 2. images --------------------------------------------------------------
for name in "${PLUGINS[@]}"; do
  dir="$SRC/plugins/$name/backend"
  img="$REGISTRY/opsweave/$name:$version"
  if sudo docker image inspect "$img" >/dev/null 2>&1; then
    say "$name: $version already built on this host"
  else
    say "$name: building $version"
    sudo docker build --build-arg PLUGIN_VERSION="$version" -t "$img" "$dir" >/dev/null
  fi
  # A push that failed must stop the publish. This used to be
  # `docker push ... || true` followed by an unconditional "pushed" line, so an
  # unreachable registry, a rejected layer or a full disk all printed success -
  # and the bundle that followed pointed at an image that was not there.
  if ! sudo docker push "$img" >/dev/null; then
    die "$name: pushing $img failed; the registry does not have this version"
  fi
  say "$name: pushed $img"
done

# The image must carry the resolver that reads `x-opsweave-user-context`. Without
# it the plugin answers 401 to every gateway call and the console signs the
# operator out - the defect this whole path exists to prevent.
sudo docker run --rm --entrypoint /bin/sh "$REGISTRY/opsweave/data-catalog:$version" \
  -c 'test -f /app/identity.mjs' \
  || die "the built data-catalog image is missing identity.mjs"

# --- 3. bundles -------------------------------------------------------------
if [ ! -f "$PUBLISHER_KEY" ]; then
  say "no publisher key at $PUBLISHER_KEY; creating one for this deployment"
  sudo docker exec "$KERNEL_CONTAINER" /usr/local/bin/opsctl keygen --out-dir /tmp/opsweave-keygen >/dev/null
  sudo docker cp "$KERNEL_CONTAINER:/tmp/opsweave-keygen/publisher.key" "$PUBLISHER_KEY" >/dev/null
  sudo docker cp "$KERNEL_CONTAINER:/tmp/opsweave-keygen/publisher.pub" "$PUBLISHER_PUB" >/dev/null
  sudo docker exec "$KERNEL_CONTAINER" rm -rf /tmp/opsweave-keygen
  sudo chown root:root "$PUBLISHER_KEY" "$PUBLISHER_PUB"
  sudo chmod 0600 "$PUBLISHER_KEY"
  sudo chmod 0644 "$PUBLISHER_PUB"
  say "publisher key created at $PUBLISHER_KEY"
fi
# The public half must exist even if this host was provisioned before the
# script kept it: the key on staging was created by an earlier version that
# copied only the private file, so the deploy failed with
#   no /srv/opsweave-staging/publisher.pub; cannot register the publisher
# Derive it from the private key instead of demanding that history never
# happened. Ed25519 seeds are PKCS#8-wrapped here, which node can do.
if [ ! -f "$PUBLISHER_PUB" ]; then
  say "deriving $PUBLISHER_PUB from the private key"
  seed_hex="$(sudo tr -d '\n' < "$PUBLISHER_KEY")"
  # python3 + cryptography is on the host; node is not.
  derived="$(printf '%s' "$seed_hex" | python3 -c '
import sys
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
raw = bytes.fromhex(sys.stdin.read().strip())
key = Ed25519PrivateKey.from_private_bytes(raw)
pub = key.public_key().public_bytes(
    encoding=serialization.Encoding.Raw,
    format=serialization.PublicFormat.Raw,
)
sys.stdout.write(pub.hex())
' 2>/dev/null || true)"
  [ -n "$derived" ] || die "could not derive the public key from $PUBLISHER_KEY"
  printf '%s\n' "$derived" | sudo tee "$PUBLISHER_PUB" >/dev/null
  sudo chown root:root "$PUBLISHER_PUB"
  sudo chmod 0644 "$PUBLISHER_PUB"
  say "derived public key $derived"
fi



email="$(sudo grep -E '^OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL=' "$DATA/kernel.env" | cut -d= -f2-)"
pass="$(sudo grep -E '^OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD=' "$DATA/kernel.env" | cut -d= -f2-)"
[ -n "$email" ] && [ -n "$pass" ] || die "bootstrap admin credentials are absent from $DATA/kernel.env"

sudo docker exec "$KERNEL_CONTAINER" /usr/local/bin/opsctl --url "$KERNEL_URL" \
  login --email "$email" --password "$pass" >/dev/null
say "opsctl authenticated"

# Register the public half. Idempotent (the endpoint upserts); see the note at
# the top of this file.
#
# This sits AFTER `opsctl login` on purpose. The first version put it before the
# login and died with "no opsctl session token; cannot call the publishers API" -
# the session file it reads is written by that login.
publisher_id="${PUBLISHER_ID:-trusted-team}"
pub_hex="$(tr -d '\n' < "$PUBLISHER_PUB")"
[ -n "$pub_hex" ] || die "empty public key in $PUBLISHER_PUB"
say "publisher $publisher_id public key: $pub_hex"
registered="$(sudo docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc \
  "SELECT count(*) FROM kernel.trusted_publishers WHERE publisher_id='$publisher_id' AND public_key_hex='$pub_hex' AND trust_state='TRUSTED'")"
if [ "$registered" != "0" ]; then
  say "publisher $publisher_id already trusts this key"
else
  say "registering publisher $publisher_id"
  # The admin API is the supported path; writing the table directly would skip
  # its validation. `opsctl login` (above) stores {token, csrf} and sends the
  # token as a bearer
  # credential with `x-csrf-token` - not as a cookie (apps/opsctl/src/main.rs:115-118,
  # :170-171). Reusing that saved session is what lets this call the admin API
  # without a second login.
  session="$(sudo docker exec "$KERNEL_CONTAINER" sh -c 'cat "${HOME:-/home/opsweave}/.opsweave/session.json" 2>/dev/null' || true)"
  token="$(printf '%s' "$session" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("token",""))' 2>/dev/null || true)"
  csrf="$(printf '%s' "$session" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("csrf",""))' 2>/dev/null || true)"
  [ -n "$token" ] || die "no opsctl session token; cannot call the publishers API"
  curl -fsS -m 20 -X POST "$KERNEL_URL/api/v1/publishers" \
    -H "authorization: Bearer $token" \
    -H "x-csrf-token: $csrf" \
    -H 'content-type: application/json' \
    -d "{\"publisherId\":\"$publisher_id\",\"publicKeyHex\":\"$pub_hex\",\"note\":\"registered by the staging deploy\"}" \
    >/dev/null \
    || die "could not register publisher $publisher_id; a bundle signed with this key would be refused"
  say "publisher $publisher_id registered"
fi

for name in "${PLUGINS[@]}"; do
  plugin="opsweave.$name"
  installed="$(sudo docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc \
    "SELECT count(*) FROM kernel.plugin_packages WHERE plugin_id='$plugin' AND version='$version'")"
  # AN INSTALLED PACKAGE IS NOT A DEPLOYED PLUGIN.
  #
  # This used to `continue` here, skipping the deploy as well as the install. The
  # consequence is the state staging has been stuck in: a publish installed the
  # package, the deploy failed (INSTANCE_CAPACITY_EXCEEDED), and every later
  # publish of that version short-circuited on "already installed" - so the
  # deploy was never retried and the plugin was never running.
  #
  # The version is a content hash, so "already installed" is a true statement
  # about the artifact and says nothing about whether it is deployed. Install and
  # deploy are separate steps with separate failure modes; only the install is
  # idempotent-by-version.
  if [ "$installed" != "0" ]; then
    say "$plugin@$version already installed; re-checking its deployment"
    # `--activate`, not `--wait`. READY is a statement about containers; the
    # gateway routes on `r.status = 'ACTIVE'`, so a publish that stops at READY
    # leaves the previous version serving while every command in the chain exits
    # 0. That is what this script did, and it is why staging could install and
    # deploy a plugin and still answer from the old one.
    #
    # `--activate` waits for READY, activates, then reads the plugin's active
    # version back and fails if it is not the one just published. The `|| true`
    # is deliberately NOT here - a failed deploy must fail the run, which is the
    # whole point.
    sudo docker exec "$KERNEL_CONTAINER" /usr/local/bin/opsctl --url "$KERNEL_URL" \
      deploy "$plugin" "$version" --wait --activate 2>&1 | tail -3
    continue
  fi
  img="$REGISTRY/opsweave/$name@$(sudo docker inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/opsweave/$name:$version" | cut -d@ -f2)"
  say "$plugin@$version: assembling a bundle against $img"

  sudo rm -rf "/tmp/opsweave-bundle-$name"
  sudo python3 "$SRC/scripts/assemble_plugin.py" \
    --template "$SRC/plugins/$name/manifest.template.json" \
    --out "/tmp/opsweave-bundle-$name" \
    --version "$version" \
    --image-ref "$img" \
    --frontend-dist "$SRC/plugins/$name/web/dist" >/dev/null

  # docker cp writes as root; the container runs as opsweave (uid 10001), and
  # `opsctl bundle` reads both the directory and the key as that user.
  sudo docker cp "/tmp/opsweave-bundle-$name" "$KERNEL_CONTAINER:/tmp/bundle-$name" >/dev/null
  sudo docker exec -u 0 "$KERNEL_CONTAINER" chown -R opsweave:opsweave "/tmp/bundle-$name"
  sudo docker cp "$PUBLISHER_KEY" "$KERNEL_CONTAINER:/tmp/publisher.key" >/dev/null
  KEY_IN_CONTAINER=1
  sudo docker exec -u 0 "$KERNEL_CONTAINER" chown opsweave:opsweave /tmp/publisher.key
  sudo docker exec -u 0 "$KERNEL_CONTAINER" chmod 0400 /tmp/publisher.key

  sudo docker exec "$KERNEL_CONTAINER" /usr/local/bin/opsctl --url "$KERNEL_URL" \
    bundle --dir "/tmp/bundle-$name" --out "/tmp/$name.plugin.zip" --key /tmp/publisher.key >/dev/null
  sudo docker exec "$KERNEL_CONTAINER" /usr/local/bin/opsctl --url "$KERNEL_URL" \
    install "/tmp/$name.plugin.zip" 2>&1 | tail -1
  sudo docker exec "$KERNEL_CONTAINER" /usr/local/bin/opsctl --url "$KERNEL_URL" \
    deploy "$plugin" "$version" --wait --activate 2>&1 | tail -3

  # The fast path; the EXIT trap covers every other way out of this loop.
  if sudo docker exec "$KERNEL_CONTAINER" rm -f /tmp/publisher.key; then
    KEY_IN_CONTAINER=0
  fi
  sudo docker exec "$KERNEL_CONTAINER" rm -f "/tmp/$name.plugin.zip"
  sudo rm -rf "/tmp/opsweave-bundle-$name"
done

say "data plugin bundles installed at $version"
