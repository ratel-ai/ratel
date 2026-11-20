#!/usr/bin/env bash
# Check that Linux gnu native addons (.node) run on an old glibc.
#
# Vercel and AWS Lambda run Node on Amazon Linux 2023 (glibc 2.34). An addon that
# needs a newer glibc symbol does not load there ("Cannot find native binding").
# For each addon, this script starts the image in $LOAD_IMAGE and:
#   1. reads the highest GLIBC_ symbol version with `objdump -T` and fails above $MAX_GLIBC;
#   2. loads the addon with Node (`require`) and fails if the load fails.
#
# Usage: scripts/check-native-glibc.sh <dir>/ratel-sdk.linux-x64-gnu.node [...]
# Needs: docker. The addon architecture comes from its file name (linux-x64-gnu or
# linux-arm64-gnu). Run it on a host of the same architecture.
# Env:   MAX_GLIBC   highest allowed GLIBC_ version (default 2.28)
#        LOAD_IMAGE  image that loads the addon (default amazonlinux:2023)
set -euo pipefail

MAX_GLIBC="${MAX_GLIBC:-2.28}"
LOAD_IMAGE="${LOAD_IMAGE:-amazonlinux:2023}"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <file.node> [...]" >&2
  exit 2
fi

for addon in "$@"; do
  case "$addon" in
    *linux-x64-gnu*) platform=linux/amd64 ;;
    *linux-arm64-gnu*) platform=linux/arm64 ;;
    *)
      echo "error: $addon: name has no linux-x64-gnu or linux-arm64-gnu triple" >&2
      exit 2
      ;;
  esac
  dir="$(cd "$(dirname "$addon")" && pwd)"
  name="$(basename "$addon")"

  echo "== $name in $LOAD_IMAGE ($platform), max GLIBC_$MAX_GLIBC"
  docker run --rm --platform "$platform" \
    -e MAX_GLIBC="$MAX_GLIBC" -e ADDON="/addon/$name" \
    -v "$dir:/addon:ro" "$LOAD_IMAGE" bash -euo pipefail -c '
      dnf install -y -q binutils nodejs >/dev/null
      echo "image glibc: $(ldd --version | head -1)"
      echo "node: $(node --version)"

      need="$(objdump -T "$ADDON" | grep -o "GLIBC_[0-9][0-9.]*" | sed "s/GLIBC_//" | sort -uV | tail -1)"
      echo "max GLIBC symbol: GLIBC_$need"
      if [ "$(printf "%s\n%s\n" "$need" "$MAX_GLIBC" | sort -V | tail -1)" != "$MAX_GLIBC" ]; then
        echo "error: $ADDON needs GLIBC_$need, above the GLIBC_$MAX_GLIBC limit" >&2
        objdump -T "$ADDON" | grep "GLIBC_$need" >&2
        exit 1
      fi

      node -e "
        const addon = require(process.argv[1]);
        const names = Object.keys(addon);
        if (names.length === 0) throw new Error(\"the addon exports nothing\");
        console.log(\"require OK: \" + names.length + \" exports (\" + names.slice(0, 5).join(\", \") + \", ...)\");
      " "$ADDON"
    '
done
