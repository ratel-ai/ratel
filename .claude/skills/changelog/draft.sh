#!/usr/bin/env bash
# Draft per-package CHANGELOG entries via git-cliff.
#
# Usage:
#   draft.sh [<from-ref>]
#
# If <from-ref> is omitted, uses the most recent tag (`git describe --tags --abbrev=0`).
# Emits one section per published package, headed by `### <package-name>`.
# Output goes to stdout — the /changelog skill captures and curates it.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if ! command -v git-cliff >/dev/null 2>&1; then
  cat >&2 <<'EOF'
git-cliff not found. Install with one of:

  brew install git-cliff
  cargo install git-cliff
  npm install -g git-cliff

Then re-run.
EOF
  exit 127
fi

from_ref="${1:-$(git describe --tags --abbrev=0 2>/dev/null || true)}"
if [ -z "$from_ref" ]; then
  echo "no tags found and no <from-ref> provided" >&2
  exit 1
fi

range="${from_ref}..HEAD"

declare -a packages=(
  "ratel-ai-core|src/core/**|Cargo.toml"
  "@ratel-ai/sdk|src/sdk/ts/**"
)

for entry in "${packages[@]}"; do
  IFS='|' read -r name path1 path2 <<<"$entry"
  echo "### ${name}"
  args=(--config cliff.toml --strip all "$range" --include-path "$path1")
  if [ -n "${path2:-}" ]; then
    args+=(--include-path "$path2")
  fi
  out=$(git-cliff "${args[@]}" 2>/dev/null || true)
  if [ -z "$(echo "$out" | tr -d '[:space:]')" ]; then
    echo "_No package-specific changes; released in lockstep with workspace._"
  else
    echo "$out"
  fi
  echo
done
