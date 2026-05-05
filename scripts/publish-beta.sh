#!/usr/bin/env bash
set -euo pipefail

# Publish all TS packages + docker image as a beta release.
# Usage: ./scripts/publish-beta.sh
#
# Requires:
#   - npm auth (browser-based passkey confirmation)
#   - docker login to Docker Hub (via `docker login`)

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TS="$ROOT/src/ts-packages"
PACKAGES=(sdk fe-client mastra react)
DOCKER_IMAGE="agentified/agentified-core"

# ── Resolve next beta version ────────────────────────────────────────
current=$(node -p "require('$TS/sdk/package.json').version")
base="${current%-beta.*}"
if [[ "$current" == *-beta.* ]]; then
  n="${current##*-beta.}"
  next="$base-beta.$((n + 1))"
else
  next="$base-beta.0"
fi
echo "Version: $current → $next"

# ── Bump versions ────────────────────────────────────────────────────
for pkg in "${PACKAGES[@]}"; do
  sed -i.bak "s/\"version\": \"$current\"/\"version\": \"$next\"/" "$TS/$pkg/package.json"
  rm -f "$TS/$pkg/package.json.bak"
done
echo "Bumped all packages to $next"

# ── Build & test ─────────────────────────────────────────────────────
echo "Building..."
(cd "$TS" && pnpm build)

echo "Testing..."
(cd "$TS" && pnpm test -- --run)

# ── Publish to npm ───────────────────────────────────────────────────
echo "Publishing to npm..."
for pkg in "${PACKAGES[@]}"; do
  echo "  → $pkg"
  (cd "$TS/$pkg" && pnpm publish --tag beta --no-git-checks)
done
echo "All packages published to npm with tag 'beta'"

# ── Docker build & push ──────────────────────────────────────────────
echo "Building docker image..."
SHORT_SHA=$(git -C "$ROOT" rev-parse --short HEAD)
docker build -t "$DOCKER_IMAGE:$next" -t "$DOCKER_IMAGE:$SHORT_SHA" "$ROOT/src/core"

echo "Pushing docker image..."
docker push "$DOCKER_IMAGE:$next"
docker push "$DOCKER_IMAGE:$SHORT_SHA"
echo "Docker image pushed: $DOCKER_IMAGE:$next, $DOCKER_IMAGE:$SHORT_SHA"

# ── Commit & push version bump ───────────────────────────────────────
echo "Committing version bump..."
git -C "$ROOT" add \
  "$TS/sdk/package.json" \
  "$TS/fe-client/package.json" \
  "$TS/mastra/package.json" \
  "$TS/react/package.json"
git -C "$ROOT" commit -m "chore: bump to $next"
git -C "$ROOT" push

echo "Done! Published $next"
