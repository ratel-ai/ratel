#!/usr/bin/env bash
# Draft per-unit CHANGELOG entries via git-cliff (ADR-0016 / ADR-0008).
#
# Usage:
#   draft.sh [<from-ref>] [--unit <id>]
#
# The release units and their git-cliff scopes come from scripts/release-units.mjs
# (the single source of truth: core, sdk-ts, sdk-py). With --unit, drafts only that
# unit; otherwise all of them. When <from-ref> is omitted each unit ranges from ITS
# OWN last release tag (`<prefix>*`), since the units now release independently.
#
# Emits one `### <package-name>` section per unit on stdout — the /changelog skill
# captures and curates it.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

UNITS_CLI="scripts/release-units.mjs"
SENTINEL="_No user-facing changes._"

from_ref=""
only_unit=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --unit) only_unit="$2"; shift 2 ;;
    *)      from_ref="$1"; shift ;;
  esac
done

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

# Units to draft: one, or all from the registry.
units=()
if [[ -n "$only_unit" ]]; then
  units=("$only_unit")
else
  while IFS= read -r u; do units+=("$u"); done < <(node "$UNITS_CLI" --list)
fi

for unit in "${units[@]}"; do
  # git-cliff scope for this unit: "name|glob1|glob2..." from the registry.
  IFS='|' read -r -a row < <(node "$UNITS_CLI" --changelog-map "$unit")
  name="${row[0]}"
  paths=("${row[@]:1}")

  # Range: an explicit from-ref overrides; otherwise this unit's own last tag.
  if [[ -n "$from_ref" ]]; then
    unit_from="$from_ref"
  else
    prefix="$(node "$UNITS_CLI" --tag-prefix "$unit")"
    unit_from="$(git describe --tags --match "${prefix}*" --abbrev=0 2>/dev/null || true)"
  fi

  echo "### ${name}"
  args=(--config cliff.toml --strip all)
  # No range when the unit has never shipped -> git-cliff spans all of history.
  [[ -n "$unit_from" ]] && args+=("${unit_from}..HEAD")
  for p in "${paths[@]}"; do args+=(--include-path "$p"); done

  out=$(git-cliff "${args[@]}" 2>/dev/null || true)
  if [ -z "$(echo "$out" | tr -d '[:space:]')" ]; then
    echo "$SENTINEL"
  else
    echo "$out"
  fi
  echo
done
