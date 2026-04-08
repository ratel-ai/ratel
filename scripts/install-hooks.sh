#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK_SRC="$REPO_ROOT/scripts/pre-commit"
HOOK_DST="$REPO_ROOT/.git/hooks/pre-commit"

if [ ! -f "$HOOK_SRC" ]; then
  echo "Error: pre-commit hook source not found at $HOOK_SRC"
  exit 1
fi

ln -sf "$HOOK_SRC" "$HOOK_DST"
chmod +x "$HOOK_SRC"

echo "Pre-commit hook installed successfully."
