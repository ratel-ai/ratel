#!/usr/bin/env bash
exec node --no-warnings "$(dirname "$0")/run-tool.ts" "$1"
