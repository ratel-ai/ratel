#!/usr/bin/env bash
# Manual per-unit publish helper for first-publish-of-a-new-package situations
# (Trusted Publishers can't be configured for a package that doesn't exist yet).
#
# After Trusted Publishers are configured, use the release.yml workflow instead —
# it publishes via OIDC with provenance and no stored tokens.
#
# Release units (ADR-0016), each publishable independently:
#   core       -> ratel-ai-core on crates.io          (cargo publish)
#   sdk-js     -> @ratel-ai/sdk + 5 platform pkgs, npm (npm publish, tarballs)
#   sdk-py     -> ratel-ai on PyPI                     (twine upload, wheels + sdist)
#   telemetry  -> @ratel-ai/telemetry (npm) + ratel-ai-telemetry (PyPI + crate)
# Each unit's version is read from its own manifest via scripts/release-units.mjs
# (the single source of truth) — units are NOT assumed to share a version.
#
# telemetry is pure-language (no cross-compiled native binaries), so this helper
# BUILDS its npm/PyPI/crate artifacts locally — it needs no --from-run/--from-dir.
#
# Usage:
#   scripts/publish-rc.sh --unit sdk-js --from-run <run-id> [--tag rc] [--dry-run]
#   scripts/publish-rc.sh --unit sdk-py --from-dir <path>   [--dry-run]
#   scripts/publish-rc.sh --unit core                       [--dry-run]
#   scripts/publish-rc.sh --unit telemetry                  [--dry-run]
#   scripts/publish-rc.sh --from-dir <path>                 # all units
#
# Options:
#   --unit <id>        core | sdk-js | sdk-py | telemetry. Repeatable. Default: all.
#   --from-run <id>    Download all artifacts from the given GH Actions run
#                      (requires `gh auth login`); tarballs/wheels are found within.
#   --from-dir <path>  Use a directory already holding the tarballs/wheels.
#   --tag <name>       npm dist-tag (default: rc). PyPI/crates use the version's
#                      own pre-release semantics; there is no dist-tag concept.
#   --dry-run          Print what would be published; don't actually publish.
#
# Idempotent: every registry is queried (or `--skip-existing` used) before an
# upload, so a partial failure is safe to resume by re-running the same command.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLATFORMS=(darwin-arm64 darwin-x64 linux-x64-gnu linux-arm64-gnu win32-x64-msvc)
TAG="rc"
FROM_DIR=""
FROM_RUN=""
DRY_RUN=0
declare -a SELECTED=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --unit)     SELECTED+=("$2"); shift 2 ;;
    --from-run) FROM_RUN="$2"; shift 2 ;;
    --from-dir) FROM_DIR="$2"; shift 2 ;;
    --tag)      TAG="$2"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  sed -n '2,36p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Default to all units. Validate each against the shared registry.
# (while-read, not mapfile — this helper runs on macOS's bash 3.2 too.)
if [[ ${#SELECTED[@]} -eq 0 ]]; then
  while IFS= read -r u; do SELECTED+=("$u"); done < <(node "$REPO_ROOT/scripts/release-units.mjs" --list)
fi
VALID_UNITS="$(node "$REPO_ROOT/scripts/release-units.mjs" --list | tr '\n' ' ')"
for u in "${SELECTED[@]}"; do
  case " $VALID_UNITS " in
    *" $u "*) ;;
    *) echo "error: unknown unit '$u' (valid: $VALID_UNITS)" >&2; exit 2 ;;
  esac
done

selected() { [[ " ${SELECTED[*]} " == *" $1 "* ]]; }
resolve_version() { node "$REPO_ROOT/scripts/release-units.mjs" --version "$1"; }

# npm-only units need artifacts on disk; core (cargo) builds from the repo.
NEEDS_ARTIFACTS=0
selected sdk-js && NEEDS_ARTIFACTS=1
selected sdk-py && NEEDS_ARTIFACTS=1
if [[ $NEEDS_ARTIFACTS -eq 1 && -z "$FROM_DIR" && -z "$FROM_RUN" ]]; then
  echo "error: sdk-js/sdk-py need --from-run <id> or --from-dir <path>" >&2
  exit 2
fi
if [[ -n "$FROM_RUN" && -z "$FROM_DIR" ]]; then
  FROM_DIR="$(mktemp -d)"
  echo "==> downloading all artifacts from run $FROM_RUN to $FROM_DIR"
  gh run download "$FROM_RUN" -D "$FROM_DIR" --repo ratel-ai/ratel
fi

echo "==> units:   ${SELECTED[*]}"
echo "==> npm tag: $TAG"
[[ $DRY_RUN -eq 1 ]] && echo "==> DRY RUN (no actual publishes)"
echo

# Wrapper around `npm publish` that treats "previously published" as success
# (fallback when the registry's HTTP pre-check missed due to CDN/replication lag)
# without breaking npm's 2FA UX. stdout is left flowing so npm's TTY-detection
# picks the right 2FA flow; only stderr is captured (via tee) to inspect the 403.
publish_one_npm() {
  local file="$1" err_file
  err_file="$(mktemp)"
  if npm publish "$file" --access public --tag "$TAG" --provenance=false \
       2> >(tee "$err_file" >&2); then
    rm -f "$err_file"; return 0
  fi
  if grep -q "previously published versions" "$err_file"; then
    rm -f "$err_file"; echo "    already published (caught at publish time), continuing"; return 0
  fi
  rm -f "$err_file"; return 1
}

# ---------- sdk-js: npm loader + 5 platform packages ----------
publish_sdk_js() {
  local version; version="$(resolve_version sdk-js)"
  echo "===== sdk-js @ $version (npm) ====="
  # A dry-run only validates the publish plan, so it doesn't need credentials.
  if [[ $DRY_RUN -eq 0 ]]; then
    if ! npm whoami >/dev/null 2>&1; then
      echo "error: not logged in to npm. run 'npm login' first." >&2; exit 1
    fi
    echo "    npm user: $(npm whoami)"
  fi

  # Order matters: the 5 subpackages (referenced by the loader's
  # optionalDependencies) publish before the loader.
  local -a packages=()
  local t
  for t in "${PLATFORMS[@]}"; do
    packages+=("ratel-ai-sdk-${t}-${version}.tgz|@ratel-ai/sdk-${t}")
  done
  packages+=("ratel-ai-sdk-${version}.tgz|@ratel-ai/sdk")

  # Pre-flight: locate every expected tarball inside FROM_DIR.
  local -a files=()
  local entry file found cand
  for entry in "${packages[@]}"; do
    file="${entry%%|*}"
    # first match; while-read avoids a `find | head` pipeline tripping pipefail.
    found=""
    while IFS= read -r cand; do found="$cand"; break; done < <(find "$FROM_DIR" -name "$file")
    if [[ -z "$found" ]]; then echo "missing tarball: $file (in $FROM_DIR)" >&2; exit 1; fi
    files+=("$found")
  done

  local i name enc_name url status
  for i in "${!packages[@]}"; do
    name="${packages[$i]##*|}"; file="${files[$i]}"
    echo "----- $name@$version -----"
    enc_name="${name//\//%2F}"
    url="https://registry.npmjs.org/${enc_name}/${version}"
    status="$(curl -sS -o /dev/null -w '%{http_code}' "$url" || echo 000)"
    if [[ "$status" == "200" ]]; then echo "    already published, skipping"; continue; fi
    if [[ $DRY_RUN -eq 1 ]]; then
      echo "    [dry-run] npm publish $file --access public --tag $TAG --provenance=false"; continue
    fi
    publish_one_npm "$file" || exit 1
  done
  echo "==> sdk-js npm publishes complete"; echo
}

# ---------- sdk-py: PyPI wheels + sdist via twine ----------
publish_sdk_py() {
  local version; version="$(resolve_version sdk-py)"
  echo "===== sdk-py @ $version (PyPI) ====="
  if ! command -v twine >/dev/null 2>&1; then
    echo "error: twine not found. 'pip install twine' (auth via TWINE_* env or ~/.pypirc)." >&2; exit 1
  fi

  # Collect this version's wheels + sdist from FROM_DIR.
  local -a dists=()
  local f
  while IFS= read -r f; do dists+=("$f"); done < <(
    find "$FROM_DIR" \( -name "ratel_ai-*.whl" -o -name "ratel_ai-*.tar.gz" \) | sort
  )
  if [[ ${#dists[@]} -eq 0 ]]; then
    echo "missing: no ratel_ai wheels/sdist found in $FROM_DIR" >&2; exit 1
  fi
  echo "    artifacts:"; printf '      %s\n' "${dists[@]}"

  # `twine check` validates metadata/README rendering before any upload.
  twine check "${dists[@]}"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "    [dry-run] twine upload --skip-existing ${dists[*]}"; echo; return 0
  fi
  # --skip-existing makes re-runs idempotent (already-uploaded files are skipped).
  twine upload --skip-existing "${dists[@]}"
  echo "==> sdk-py PyPI publish complete"; echo
}

# ---------- core: crates.io ----------
# crates.io has no dist-tag; a pre-release version (0.2.0-rc.1) is simply not
# selected by consumers unless they ask for it explicitly.
publish_core() {
  local version; version="$(resolve_version core)"
  echo "===== core @ $version (crates.io) ====="
  cd "$REPO_ROOT"
  local status
  # crates.io's data-access policy 403s a generic `curl/*` User-Agent, so a
  # UA-less check would ALWAYS look "not published" and never skip. Send a
  # descriptive UA (with contact) as their policy requires.
  status="$(curl -sS -o /dev/null -w '%{http_code}' \
    -H 'User-Agent: ratel-publish-rc (roberto@ratel.sh)' \
    "https://crates.io/api/v1/crates/ratel-ai-core/${version}" || echo 000)"
  if [[ "$status" == "200" ]]; then
    echo "    already published, skipping"; echo; return 0
  fi
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "    [dry-run] cargo publish -p ratel-ai-core"; echo; return 0
  fi
  local out
  if out="$(cargo publish -p ratel-ai-core 2>&1)"; then
    printf '%s\n' "$out"
  elif printf '%s' "$out" | grep -qE "already (exists|uploaded)|crate version .* is already uploaded"; then
    echo "    already published (caught at publish time), continuing"
  else
    printf '%s\n' "$out" >&2; exit 1
  fi
  echo
}

# ---------- telemetry: npm + PyPI + crate, all built locally ----------
# The one 3-registry unit. Pure-language, so nothing comes from a CI run: build
# the npm package (tsc), the pure-python wheel+sdist (python -m build), and the
# crate (cargo publish from the repo), each idempotent against its registry.
publish_telemetry() {
  local version; version="$(resolve_version telemetry)"
  echo "===== telemetry @ $version (npm + PyPI + crates.io) ====="

  # -- npm: @ratel-ai/telemetry --
  echo "----- @ratel-ai/telemetry@$version (npm) -----"
  local status
  status="$(curl -sS -o /dev/null -w '%{http_code}' \
    "https://registry.npmjs.org/@ratel-ai%2Ftelemetry/${version}" || echo 000)"
  if [[ "$status" == "200" ]]; then
    echo "    already published, skipping npm"
  else
    if [[ $DRY_RUN -eq 0 ]] && ! npm whoami >/dev/null 2>&1; then
      echo "error: not logged in to npm. run 'npm login' first." >&2; exit 1
    fi
    ( cd "$REPO_ROOT" && pnpm --filter @ratel-ai/telemetry run build )
    if [[ $DRY_RUN -eq 1 ]]; then
      echo "    [dry-run] npm publish (src/telemetry/ts) --access public --tag $TAG --provenance=false"
    else
      ( cd "$REPO_ROOT/src/telemetry/ts" && npm publish --access public --tag "$TAG" --provenance=false )
    fi
  fi

  # -- PyPI: ratel-ai-telemetry (pure-python wheel + sdist) --
  echo "----- ratel-ai-telemetry@$version (PyPI) -----"
  if ! command -v twine >/dev/null 2>&1; then
    echo "error: twine not found. 'pip install twine build' (auth via TWINE_* env or ~/.pypirc)." >&2; exit 1
  fi
  local dist; dist="$(mktemp -d)"
  ( cd "$REPO_ROOT" && python -m build --outdir "$dist" src/telemetry/python )
  twine check "$dist"/*
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "    [dry-run] twine upload --skip-existing $dist/*"
  else
    # --skip-existing keeps re-runs idempotent.
    twine upload --skip-existing "$dist"/*
  fi

  # -- crates.io: ratel-ai-telemetry --
  echo "----- ratel-ai-telemetry@$version (crates.io) -----"
  status="$(curl -sS -o /dev/null -w '%{http_code}' \
    -H 'User-Agent: ratel-publish-rc (roberto@ratel.sh)' \
    "https://crates.io/api/v1/crates/ratel-ai-telemetry/${version}" || echo 000)"
  if [[ "$status" == "200" ]]; then
    echo "    already published, skipping crate"
  elif [[ $DRY_RUN -eq 1 ]]; then
    echo "    [dry-run] cargo publish -p ratel-ai-telemetry"
  else
    local out
    if out="$(cd "$REPO_ROOT" && cargo publish -p ratel-ai-telemetry 2>&1)"; then
      printf '%s\n' "$out"
    elif printf '%s' "$out" | grep -qE "already (exists|uploaded)|crate version .* is already uploaded"; then
      echo "    already published (caught at publish time), continuing"
    else
      printf '%s\n' "$out" >&2; exit 1
    fi
  fi
  echo "==> telemetry publishes complete"; echo
}

# Publish in a stable order regardless of --unit argument order.
selected core      && publish_core
selected sdk-js    && publish_sdk_js
selected sdk-py    && publish_sdk_py
selected telemetry && publish_telemetry

echo "==> done"
echo
echo "next steps:"
echo "  1. verify on a clean machine (no local toolchain) via the Verify install"
echo "     workflow: gh workflow run verify-install.yml -f unit=<unit> -f version=<ver>"
echo "  2. configure Trusted Publishers for each published name (see RELEASING.md,"
echo "     'first-time bootstrap'), all pointing at release.yml / the release env"
echo "  3. push the next tag (e.g. <unit>-v<ver>) to validate the CI publish path"
