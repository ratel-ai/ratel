#!/usr/bin/env bash
# Builds what the @ratel-ai/rankers-plugin publish packs, once its native loader
# (src/rankers/ts/native/index.cjs + index.d.cts) is in place. The plugin's tsc
# reads the SDK's dist/, and the SDK's tsc needs its own gitignored native loader,
# which only its native build generates, so the SDK (and telemetry) build in full.
# Run by release.yml's publish-rankers-ts, publish-rc.sh and ci.yml (ADR-0028).
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm --filter "@ratel-ai/sdk..." run build
pnpm --filter @ratel-ai/rankers-plugin run build:ts
