#!/usr/bin/env bash
# usage: run-log.sh <out> <title> <code-line> <expected> <cmd...>; runs cmd in cwd, logs header + output + exit code
out=$1 title=$2 code=$3 expected=$4; shift 4
{ echo "# $title"
  echo "# date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# code: $code"
  echo "# cwd: ratel/${PWD#*/ratel-*/}"
  echo "# command: $*"
  echo "# expected: $expected"; echo
  "$@" 2>&1; rc=$?
  echo; echo "# exit code: $rc"; } > "$out"
