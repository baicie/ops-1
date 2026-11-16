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
# WHAT IT NEVER DOES
#
# It does not rotate the publisher key, and it does not touch
# `kernel.trusted_publishers`. It creates the key on first run if absent, and
# signs with whatever is at $PUBLISHER_KEY.
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
PLUGINS=(data-catalog data-integration)

say() { printf '%s\n' "$*"; }
die() { printf '::error::%s\n' "$*" >&2; exit 1; }

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
src_hash="$(
  {
    cat "$SRC"/plugins/data-catalog/backend/*.mjs "$SRC"/plugins/data-integration/backend/*.mjs
    find "$SRC"/plugins/*/web/dist -type f | sort | xargs cat
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
  sudo docker push "$img" >/dev/null 2>&1 || true
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
  sudo docker exec "$KERNEL_CONTAINER" rm -rf /tmp/opsweave-keygen
  sudo chown root:root "$PUBLISHER_KEY"
  sudo chmod 0600 "$PUBLISHER_KEY"
  say "publisher key created at $PUBLISHER_KEY"
fi

email="$(sudo grep -E '^OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL=' "$DATA/kernel.env" | cut -d= -f2-)"
pass="$(sudo grep -E '^OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD=' "$DATA/kernel.env" | cut -d= -f2-)"
[ -n "$email" ] && [ -n "$pass" ] || die "bootstrap admin credentials are absent from $DATA/kernel.env"

sudo docker exec "$KERNEL_CONTAINER" /usr/local/bin/opsctl --url "$KERNEL_URL" \
  login --email "$email" --password "$pass" >/dev/null
say "opsctl authenticated"

for name in "${PLUGINS[@]}"; do
  plugin="opsweave.$name"
  installed="$(sudo docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc \
    "SELECT count(*) FROM kernel.plugin_packages WHERE plugin_id='$plugin' AND version='$version'")"
  if [ "$installed" != "0" ]; then
    say "$plugin@$version already installed; leaving it"
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
  sudo docker exec -u 0 "$KERNEL_CONTAINER" chown opsweave:opsweave /tmp/publisher.key
  sudo docker exec -u 0 "$KERNEL_CONTAINER" chmod 0400 /tmp/publisher.key

  sudo docker exec "$KERNEL_CONTAINER" /usr/local/bin/opsctl --url "$KERNEL_URL" \
    bundle --dir "/tmp/bundle-$name" --out "/tmp/$name.plugin.zip" --key /tmp/publisher.key >/dev/null
  sudo docker exec "$KERNEL_CONTAINER" /usr/local/bin/opsctl --url "$KERNEL_URL" \
    install "/tmp/$name.plugin.zip" 2>&1 | tail -1
  sudo docker exec "$KERNEL_CONTAINER" /usr/local/bin/opsctl --url "$KERNEL_URL" \
    deploy "$plugin" "$version" --wait 2>&1 | tail -2

  # The private key does not stay in the container.
  sudo docker exec "$KERNEL_CONTAINER" rm -f /tmp/publisher.key "/tmp/$name.plugin.zip"
  sudo rm -rf "/tmp/opsweave-bundle-$name"
done

say "data plugin bundles installed at $version"
