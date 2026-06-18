#!/usr/bin/env bash
# End-to-end check for the installed `@ratel-ai/cli` package.
#
# Proves the published CLI artifact actually runs and that its config round-trip
# (add -> list -> get -> remove) works. Runs under a sandboxed HOME so it never
# touches the real environment, and spawns NO live MCP servers: passing
# `--description` makes `mcp add` skip the upstream probe (see handlers/add.ts
# maybeProbeAndAuth: it returns early when a description is already set).
#
# RATEL_BIN must point at a single executable (e.g. an installed node_modules/.bin/ratel).
set -euo pipefail

RATEL="${RATEL_BIN:-ratel}"

SBX="$(mktemp -d)"
export HOME="$SBX"
cd "$SBX"

echo "using CLI: $RATEL"
echo "sandboxed HOME: $HOME"

# 1. binary loads + help
out="$("$RATEL" --help 2>&1)" || { echo "FAIL (cli): --help exited nonzero"; echo "$out"; exit 1; }
echo "$out" | grep -qiE "mcp|serve" || { echo "FAIL (cli): --help output unexpected"; echo "$out"; exit 1; }
echo "  help OK"

# 2. empty list (fresh HOME)
out="$("$RATEL" mcp list 2>&1)"; echo "$out"
echo "$out" | grep -qi "no MCP servers" || { echo "FAIL (cli): expected empty server list"; exit 1; }
echo "  empty list OK"

# 3. add a stdio entry (description suppresses the upstream probe -> no spawn)
echo "+ $RATEL mcp add demo --scope user --description '...' -- echo hello"
"$RATEL" mcp add demo --scope user --description "demo server for e2e" -- echo hello

# 4. list shows it
out="$("$RATEL" mcp list 2>&1)"; echo "$out"
echo "$out" | grep -q "demo" || { echo "FAIL (cli): 'demo' not listed after add"; exit 1; }
echo "  add+list OK"

# 5. get shows the resolved command
out="$("$RATEL" mcp get demo --scope user 2>&1)"; echo "$out"
echo "$out" | grep -q "echo" || { echo "FAIL (cli): 'echo' command not shown by get"; exit 1; }
echo "  get OK"

# 6. remove and confirm gone
echo "+ $RATEL mcp remove --name demo --scope user"
"$RATEL" mcp remove --name demo --scope user
out="$("$RATEL" mcp list 2>&1)"; echo "$out"
echo "$out" | grep -qi "no MCP servers" || { echo "FAIL (cli): entry still present after remove"; exit 1; }
echo "  remove OK"

echo "PASS (cli): help + add/list/get/remove round-trip under sandboxed HOME"
