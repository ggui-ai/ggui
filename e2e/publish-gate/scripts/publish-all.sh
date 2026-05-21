#!/usr/bin/env bash
#
# Publish every publishable @ggui-ai/* package to Verdaccio, leaf-first.
#
# The build is already baked into the gate-runner image (the Dockerfile
# runs `pnpm -r build`), so this only packs + uploads. `pnpm publish`
# rewrites `workspace:*` → the real version range, exactly as a publish
# to npmjs would.
#
# Usage: publish-all.sh <packages-root> <registry-url>
set -euo pipefail

PACKAGES_ROOT="${1:?usage: publish-all.sh <packages-root> <registry-url>}"
REGISTRY="${2:?usage: publish-all.sh <packages-root> <registry-url>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Verdaccio accepts any non-empty token when packages are `publish: $all`;
# the npm/pnpm CLI still requires _authToken to be set to attempt a publish.
HOST_PORT="${REGISTRY#http://}"
HOST_PORT="${HOST_PORT%/}"
npm config set "//${HOST_PORT}/:_authToken" "publish-gate-token"

ORDER_JSON="$(node "$SCRIPT_DIR/compute-order.mjs" "$PACKAGES_ROOT")"
COUNT="$(node -e 'process.stdin.once("data",b=>console.log(JSON.parse(b).length))' <<<"$ORDER_JSON")"
echo "  resolved $COUNT packages (leaf-first)"

# Emit "dir<TAB>name<TAB>version" lines for shell iteration.
emit() {
  node -e '
    const rev = process.argv[1] === "reverse";
    let buf = "";
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => {
      let a = JSON.parse(buf);
      if (rev) a = a.reverse();
      for (const p of a) console.log([p.dir, p.name, p.version].join("\t"));
    });
  ' "$1"
}

# Idempotent reruns: drop any existing versions first. A no-op on a
# fresh Verdaccio volume (the normal case under `make test-publish-gate`).
echo "  unpublishing any existing versions…"
emit reverse <<<"$ORDER_JSON" | while IFS=$'\t' read -r dir name version; do
  npm unpublish "$name@$version" --registry "$REGISTRY" --force >/dev/null 2>&1 \
    && echo "    - $name@$version" || true
done

echo "  publishing…"
emit forward <<<"$ORDER_JSON" | while IFS=$'\t' read -r dir name version; do
  ( cd "$PACKAGES_ROOT/$dir" \
    && pnpm publish --registry "$REGISTRY" --no-git-checks --access public >/dev/null )
  echo "    + $name@$version"
done

echo "  published $COUNT packages to $REGISTRY"
