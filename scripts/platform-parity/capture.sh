#!/usr/bin/env sh
# Capture Ratel Cloud's answers for the parity tests (temporary parity harness, RTL-45).
#
#   RATEL_CLOUD_DIR=/path/to/ratel-cloud pnpm --filter @ratel/platform parity:capture
#
# Runs capture.mts from the Cloud checkout's apps/web, so '@/…' resolves to Cloud's code and tsx
# comes from Cloud's own install. The environment is emptied first: nothing a subject does may
# reach a model, a database or a vendor.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
if [ -z "${RATEL_CLOUD_DIR:-}" ]; then
  echo "parity capture: RATEL_CLOUD_DIR is not set: point it at a ratel-cloud git checkout." >&2
  exit 1
fi
if [ ! -d "$RATEL_CLOUD_DIR/apps/web" ]; then
  echo "parity capture: $RATEL_CLOUD_DIR is not a ratel-cloud checkout (no apps/web)." >&2
  exit 1
fi
cd "$RATEL_CLOUD_DIR/apps/web"
exec env -i PATH="$PATH" HOME="$HOME" RATEL_CLOUD_DIR="$RATEL_CLOUD_DIR" \
  node --import tsx "$here/capture.mts"
