#!/usr/bin/env bash
# Manual publish helper for the v0.1.4-rc.1 bootstrap (and any future
# first-publish-of-a-new-package situation, since Trusted Publishers
# can't be configured for a package that doesn't exist yet).
#
# After Trusted Publishers are configured, use the release.yml workflow
# instead — it publishes via OIDC with provenance and no stored tokens.
#
# Usage:
#   scripts/publish-rc.sh --from-run <run-id> [--tag rc] [--dry-run] [--skip-crate]
#   scripts/publish-rc.sh --from-dir <path>   [--tag rc] [--dry-run] [--skip-crate]
#
# Options:
#   --from-run <id>    Download release-tarballs artifact from the given GH
#                      Actions run (requires `gh auth login`).
#   --from-dir <path>  Use an already-extracted tarballs directory.
#   --tag <name>       npm dist-tag (default: rc).
#   --dry-run          Print what would be published; don't actually publish.
#   --skip-npm         Skip npm publishes (only run cargo publish).
#   --skip-crate       Skip cargo publish for ratel-ai-core.
#
# The script is idempotent: it queries the registry first and skips any
# version already published, so a partial failure can be resumed by
# re-running the same command.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="rc"
FROM_DIR=""
FROM_RUN=""
DRY_RUN=0
SKIP_NPM=0
SKIP_CRATE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-run)   FROM_RUN="$2"; shift 2 ;;
    --from-dir)   FROM_DIR="$2"; shift 2 ;;
    --tag)        TAG="$2"; shift 2 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --skip-npm)   SKIP_NPM=1; shift ;;
    --skip-crate) SKIP_CRATE=1; shift ;;
    -h|--help)    sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$FROM_DIR" && -z "$FROM_RUN" ]] && [[ $SKIP_NPM -eq 0 ]]; then
  echo "error: pass --from-run <id> or --from-dir <path> (or --skip-npm)" >&2
  exit 2
fi

# Read the canonical version from the SDK loader's package.json
VERSION="$(node -p "require('$REPO_ROOT/src/sdk/ts/package.json').version")"
echo "==> version: $VERSION"
echo "==> npm dist-tag: $TAG"
[[ $DRY_RUN -eq 1 ]] && echo "==> DRY RUN (no actual publishes)"
echo

# ---------- npm publish flow ----------
if [[ $SKIP_NPM -eq 0 ]]; then
  if ! npm whoami >/dev/null 2>&1; then
    echo "error: not logged in to npm. run 'npm login' first." >&2
    exit 1
  fi
  echo "==> npm user: $(npm whoami)"

  if [[ -n "$FROM_RUN" ]]; then
    FROM_DIR="$(mktemp -d)"
    echo "==> downloading release-tarballs from run $FROM_RUN to $FROM_DIR"
    gh run download "$FROM_RUN" -n release-tarballs -D "$FROM_DIR" \
      --repo ratel-ai/ratel
  fi

  cd "$FROM_DIR"
  echo "==> tarballs in $FROM_DIR:"
  ls -1 *.tgz | sed 's/^/    /'
  echo

  # Order matters: subpackages first (loader's optionalDependencies references them),
  # then the loader, then mcp-server, then cli.
  PACKAGES=(
    "ratel-ai-sdk-darwin-arm64-${VERSION}.tgz|@ratel-ai/sdk-darwin-arm64"
    "ratel-ai-sdk-darwin-x64-${VERSION}.tgz|@ratel-ai/sdk-darwin-x64"
    "ratel-ai-sdk-linux-x64-gnu-${VERSION}.tgz|@ratel-ai/sdk-linux-x64-gnu"
    "ratel-ai-sdk-linux-arm64-gnu-${VERSION}.tgz|@ratel-ai/sdk-linux-arm64-gnu"
    "ratel-ai-sdk-win32-x64-msvc-${VERSION}.tgz|@ratel-ai/sdk-win32-x64-msvc"
    "ratel-ai-sdk-${VERSION}.tgz|@ratel-ai/sdk"
    "ratel-ai-mcp-server-${VERSION}.tgz|@ratel-ai/mcp-server"
    "ratel-ai-cli-${VERSION}.tgz|@ratel-ai/cli"
  )

  # Pre-flight: every expected tarball must exist.
  missing=0
  for entry in "${PACKAGES[@]}"; do
    file="${entry%%|*}"
    if [[ ! -f "$file" ]]; then
      echo "missing: $file" >&2
      missing=1
    fi
  done
  [[ $missing -eq 1 ]] && exit 1

  # Publish each (skip if already on registry at this version).
  for entry in "${PACKAGES[@]}"; do
    file="${entry%%|*}"
    name="${entry##*|}"
    echo "----- $name@$VERSION -----"
    if npm view "${name}@${VERSION}" version >/dev/null 2>&1; then
      echo "    already published, skipping"
      continue
    fi
    # --provenance=false overrides publishConfig.provenance=true on the
    # SDK loader / mcp-server / cli. Provenance requires GH Actions OIDC,
    # which a laptop publish doesn't have. CI publishes via release.yml
    # always go with provenance enabled.
    if [[ $DRY_RUN -eq 1 ]]; then
      echo "    [dry-run] npm publish $file --access public --tag $TAG --provenance=false"
    else
      npm publish "$file" --access public --tag "$TAG" --provenance=false
    fi
  done

  echo
  echo "==> npm publishes complete"
  echo
fi

# ---------- crates.io publish flow ----------
# crates.io has no `--tag` concept; the version itself (0.1.4-rc.1) is
# pre-release semver, so consumers won't pick it up unless they ask for it
# explicitly. The package version is in lockstep with the SDK loader, so we
# reuse $VERSION for the existence check.
if [[ $SKIP_CRATE -eq 0 ]]; then
  cd "$REPO_ROOT"
  echo "----- ratel-ai-core@$VERSION -----"
  status="$(curl -sS -o /dev/null -w '%{http_code}' \
    "https://crates.io/api/v1/crates/ratel-ai-core/${VERSION}" || echo 000)"
  if [[ "$status" == "200" ]]; then
    echo "    already published, skipping"
  elif [[ $DRY_RUN -eq 1 ]]; then
    echo "    [dry-run] cargo publish -p ratel-ai-core"
  else
    cargo publish -p ratel-ai-core
  fi
fi

echo
echo "==> done"
echo
echo "next steps:"
echo "  1. verify on a clean machine without Rust:"
echo "       npx -y @ratel-ai/cli@${TAG} --help"
echo "  2. configure Trusted Publishers for each of the 8 npm packages and"
echo "     the ratel-ai-core crate (see RELEASING.md, 'first-time bootstrap')"
echo "  3. push v${VERSION%-rc.*}-rc.2 to validate the CI publish path"
