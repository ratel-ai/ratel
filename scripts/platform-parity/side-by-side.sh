#!/usr/bin/env bash
# Run the open-source edition and Ratel Cloud side by side on the same input and report where
# they differ (temporary parity harness, RTL-45). Local only: it needs Docker, the installed
# Chrome, and a ratel-cloud checkout at the commit in scripts/platform-sync/source.json with its
# dependencies installed.
#
#   RATEL_CLOUD_DIR=/path/to/ratel-cloud scripts/platform-parity/side-by-side.sh
#   scripts/platform-parity/side-by-side.sh --compare-only     compare what the last run collected
#
# What it does, as the platform split audit did by hand:
#   - one throwaway Postgres (its own compose project and port; the root .env is not loaded,
#     and every host command runs in an emptied environment, so no model key is in reach),
#     with one database per edition;
#   - both migrated and seeded with Site Copilot at the same --anchor;
#   - both drained: this edition by its drain tick, Cloud through GET /api/cron/drain on its
#     dev server (its pipeline script cannot start at this commit);
#   - both given the match-quality seed, and drained again;
#   - then, from both: schema facts, what the seed stored, the readings row by row, MCP
#     tools/list, list_fixes, list_tasks and list_insights, and the visible text of twelve
#     pages, with the feature flags off and on.
# compare.mjs reads all of it. A difference listed as natural in expected-differences.json is
# left out; anything else is printed and the script exits 1.
#
# PARITY_WORK (default /private/tmp/ratel-parity) holds what was collected. It is outside the
# repository on purpose: it contains Cloud's output, which check:private would refuse.
# PARITY_KEEP=1 leaves the database and the servers running.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORK="${PARITY_WORK:-/private/tmp/ratel-parity}"
PROJECT="ratel-parity"
DB_PORT="${PARITY_DB_PORT:-55492}"
OSS_PORT="${PARITY_OSS_PORT:-3351}"
CLOUD_PORT="${PARITY_CLOUD_PORT:-3352}"
DB_URL="postgres://ratel:ratel@127.0.0.1:$DB_PORT"
DB_CONTAINER="$PROJECT-db-1"
ANCHOR="${PARITY_ANCHOR:-$(date -u +%Y-%m-%dT%H:00:00.000Z)}"
TABLES="trace_turns trace_turn_steps trace_signals trace_self_corrections tool_explorer_edges tool_explorer_sets otel_trace_summaries"
# name=path under the project root; twelve pages.
PAGES="overview= health=/health self-corrections=/health/self-corrections fixes=/improvement/fixes tasks=/tasks intents=/intents quality=/quality ship=/ship traces=/traces catalog-tools=/catalogs/tools settings-api-keys=/settings/api-keys playground=/playground"

if [ "${1:-}" = "--compare-only" ]; then
  exec node "$HERE/side-by-side/compare.mjs" "$WORK"
fi

say() { printf '\n== %s\n' "$*"; }
die() { echo "side by side: $*" >&2; exit 2; }

# ── preflight ───────────────────────────────────────────────────────────────────────────────
[ -n "${RATEL_CLOUD_DIR:-}" ] || die "RATEL_CLOUD_DIR is not set: point it at a ratel-cloud git checkout."
CLOUD_APP="$RATEL_CLOUD_DIR/apps/web"
[ -d "$CLOUD_APP/node_modules" ] || die "$RATEL_CLOUD_DIR has no installed dependencies (run pnpm install there)."
want="$(node -p "require('$REPO/scripts/platform-sync/source.json').commit")"
have="$(git -C "$RATEL_CLOUD_DIR" rev-parse HEAD)"
[ "$want" = "$have" ] || die "$RATEL_CLOUD_DIR is at ${have:0:8}, not at ${want:0:8} (scripts/platform-sync/source.json)."
command -v docker >/dev/null || die "docker is not installed."
# Node 24 is the floor of both applications; fetch it when the shell's node is older.
NODE_DIR="$(dirname "$(node -p process.execPath)")"
if [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 24 ]; then
  NODE_DIR="$(dirname "$(npx -y node@24 -p process.execPath)")"
fi
PNPM_DIR="$(dirname "$(command -v pnpm)")"
DOCKER_DIR="$(dirname "$(command -v docker)")"
CLEAN_PATH="$NODE_DIR:$PNPM_DIR:$DOCKER_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Every host command runs here: nothing of the shell's environment, so no model or vendor key.
clean() { env -i PATH="$CLEAN_PATH" HOME="$HOME" TERM=dumb LANG=en_US.UTF-8 NEXT_TELEMETRY_DISABLED=1 LOG_LEVEL=warn "$@"; }
oss() { (cd "$REPO/apps/web" && clean DATABASE_URL="$DB_URL/ratel_oss" DATABASE_SSL=disable BASE_URL="http://localhost:$OSS_PORT" TRACE_TURNS_IDLE_CLOSE_MS=1000 "$@"); }
cloud() { (cd "$CLOUD_APP" && clean DATABASE_URL="$DB_URL/ratel_cloud" DATABASE_SSL=disable DEV_AUTH_BYPASS=1 TRACE_TURNS_IDLE_CLOSE_MS=1000 "$@"); }
compose() { RATEL_DB_PORT="$DB_PORT" docker compose --env-file /dev/null -p "$PROJECT" -f "$REPO/docker-compose.yml" -f "$WORK/no-env.compose.yml" "$@"; }
psql_db() { local db="$1"; shift; docker exec -i "$DB_CONTAINER" psql -U ratel -d "$db" -At "$@"; }

PIDS=()
stop_servers() {
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && pkill -TERM -P "$pid" 2>/dev/null; [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
  PIDS=()
  # next dev leaves its worker behind: free the two ports.
  for port in "$OSS_PORT" "$CLOUD_PORT"; do lsof -ti "tcp:$port" 2>/dev/null | xargs kill 2>/dev/null || true; done
  sleep 2
}
cleanup() {
  if [ "${PARITY_KEEP:-}" = "1" ]; then echo "side by side: PARITY_KEEP=1, the database and servers are left running."; return; fi
  stop_servers
  compose down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for() { # url, seconds
  local i=0
  until curl -s -o /dev/null "$1"; do i=$((i + 1)); [ "$i" -gt "$2" ] && die "$1 did not answer in $2 s (see $WORK/logs)."; sleep 1; done
}

# The editions' flags, off and on. The Cloud names are its flag keys as environment switches.
# Both states are spelled out: Cloud's flags default to on in local development.
flags() { # prefix, 0 | 1
  local out=""
  for flag in SESSION_REPLAY STAGE_SPINE EVAL_GATE MCP_LOOP; do out="$out FF_$1$flag=$2"; done
  [ "$2" = "1" ] && out="$out EVAL_GATE_MOCK_MODEL=1"
  echo "$out"
}
start_servers() { # flags-off | flags-on
  local value=0; [ "$1" = "flags-on" ] && value=1
  local oss_flags cloud_flags
  oss_flags="$(flags "" "$value")"
  cloud_flags="$(flags CLOUD_ "$value")"
  # shellcheck disable=SC2086
  oss $oss_flags pnpm exec next dev -p "$OSS_PORT" >"$WORK/logs/oss-dev-$1.log" 2>&1 &
  PIDS+=($!)
  # shellcheck disable=SC2086
  cloud $cloud_flags pnpm exec next dev -p "$CLOUD_PORT" >"$WORK/logs/cloud-dev-$1.log" 2>&1 &
  PIDS+=($!)
  wait_for "http://localhost:$OSS_PORT/api/health" 180
  wait_for "http://localhost:$CLOUD_PORT/api/health" 180
}

mcp() { # base, key file, method, params, out
  curl -s -X POST "$1/api/mcp" -H "Authorization: Bearer $(cat "$2")" -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$3\",\"params\":$4}" >"$5" || true
}

collect() { # flags-off | flags-on
  say "MCP and pages, $1"
  for edition in oss cloud; do
    local port="$OSS_PORT"; [ "$edition" = cloud ] && port="$CLOUD_PORT"
    local base="http://localhost:$port" key="$WORK/keys/$edition"
    mcp "$base" "$key" tools/list '{}' "$WORK/mcp/$edition-$1-tools-list.json"
    for tool in list_fixes list_tasks list_insights; do
      mcp "$base" "$key" tools/call "{\"name\":\"$tool\",\"arguments\":{\"limit\":50}}" "$WORK/mcp/$edition-$1-$tool.json"
    done
    local project; project="$(node -p "require('$WORK/ids.json').${edition}Project")"
    local specs=()
    for page in $PAGES; do specs+=("${page%%=*}=/project/$project${page#*=}"); done
    clean node "$HERE/side-by-side/page-text.mjs" "$BROWSER" "$base" "$WORK/pages" "$edition-$1-" "${specs[@]}"
  done
}

drain_cloud() {
  local quiet=0
  for _ in $(seq 1 40); do
    curl -s "http://localhost:$CLOUD_PORT/api/cron/drain" >>"$WORK/logs/cloud-drain.log" || true
    echo >>"$WORK/logs/cloud-drain.log"
    sleep 4
    if [ "$(psql_db ratel_cloud -c "select count(*) from jobs where status in ('queued', 'running')")" = "0" ]; then quiet=$((quiet + 1)); else quiet=0; fi
    [ "$quiet" -ge 3 ] && break
  done
  return 0
}

# ── the stack ───────────────────────────────────────────────────────────────────────────────
rm -rf "$WORK/schema" "$WORK/seed" "$WORK/rows" "$WORK/mcp" "$WORK/pages" "$WORK/logs" "$WORK/keys" "$WORK/ids.json" "$WORK/report.txt"
mkdir -p "$WORK"/{schema,seed,rows,mcp,pages,logs,keys}
chmod 700 "$WORK/keys"
printf 'services:\n  web:\n    env_file: !reset []\n  worker:\n    env_file: !reset []\n' >"$WORK/no-env.compose.yml"
BROWSER="${PARITY_BROWSER_DIR:-$WORK/browser}"
if [ ! -d "$BROWSER/node_modules/puppeteer-core" ]; then
  say "installing puppeteer-core into $BROWSER"
  mkdir -p "$BROWSER" && (cd "$BROWSER" && clean npm init -y >/dev/null && clean npm install --silent puppeteer-core)
fi

say "Postgres on 127.0.0.1:$DB_PORT (compose project $PROJECT)"
compose down -v >/dev/null 2>&1 || true
compose up -d --wait db
for db in ratel_oss ratel_cloud; do psql_db ratel -c "create database $db" >/dev/null; done

say "migrate both"
oss pnpm exec tsx scripts/migrate.mts >"$WORK/logs/oss-migrate.log" 2>&1
cloud pnpm exec tsx scripts/migrate.mts >"$WORK/logs/cloud-migrate.log" 2>&1
for edition in oss cloud; do psql_db "ratel_$edition" -f - <"$HERE/side-by-side/schema-facts.sql" >"$WORK/schema/$edition.txt"; done

say "start both, flags off; Cloud's first visit creates its local-dev organization"
start_servers flags-off
curl -sL -o /dev/null "http://localhost:$CLOUD_PORT/" || true
# Limits: this edition's limits are those of Cloud's enterprise plan, so Cloud's local
# organization is put on it. Otherwise Cloud reads a 7-day window and this edition 90 days.
psql_db ratel_cloud -c "update organizations set plan_override = 'enterprise' where slug = 'local-dev'" >/dev/null

say "seed Site Copilot on both, anchor $ANCHOR"
oss pnpm exec tsx scripts/seed.mts --anchor "$ANCHOR" >"$WORK/logs/oss-seed.log" 2>&1
cloud pnpm exec tsx scripts/seed-site-copilot.mts --anchor "$ANCHOR" >"$WORK/logs/cloud-seed.log" 2>&1
oss_project="$(psql_db ratel_oss -c "select id from projects where slug = 'site-copilot'")"
cloud_project="$(psql_db ratel_cloud -c "select id from projects where slug = 'site-copilot'")"
printf '{"ossProject":"%s","cloudProject":"%s"}\n' "$oss_project" "$cloud_project" >"$WORK/ids.json"
# Per project: Cloud's first visit also provisions its own demo project.
for edition in oss cloud; do
  project="$oss_project"; [ "$edition" = cloud ] && project="$cloud_project"
  psql_db "ratel_$edition" -c "select 'trace_events|' || type || '|' || count(*) from trace_events where project_id = '$project' group by type order by type" >"$WORK/seed/$edition.txt"
done

# The readings can only be compared on the same history. Event types this edition's seed stores
# and Cloud's does not (audit item 12) are counted above, then removed before anything reads them.
extra="$(comm -13 <(cut -d'|' -f2 "$WORK/seed/cloud.txt" | sort) <(cut -d'|' -f2 "$WORK/seed/oss.txt" | sort) | sed "s/.*/'&'/" | paste -sd, -)"
if [ -n "$extra" ]; then
  psql_db ratel_oss -c "delete from trace_events where project_id = '$oss_project' and type in ($extra)" >"$WORK/logs/oss-extra-events-removed.log"
fi

say "drain both"
oss pnpm exec tsx "$HERE/side-by-side/drain-oss.mts" 10 >"$WORK/logs/oss-drain.log" 2>&1
drain_cloud

say "seed match quality on both (the description rewrites), then drain again"
oss pnpm exec tsx scripts/seed-site-copilot-quality.mts >"$WORK/logs/oss-seed-quality.log" 2>&1
cloud pnpm exec tsx scripts/seed-site-copilot-quality.mts >"$WORK/logs/cloud-seed-quality.log" 2>&1
oss pnpm exec tsx "$HERE/side-by-side/drain-oss.mts" 4 >>"$WORK/logs/oss-drain.log" 2>&1
drain_cloud

say "rows"
for edition in oss cloud; do
  project="$oss_project"; [ "$edition" = cloud ] && project="$cloud_project"
  for table in $TABLES; do
    psql_db "ratel_$edition" -c "select coalesce(json_agg(to_jsonb(t)), '[]') from \"$table\" t where project_id = '$project'" >"$WORK/rows/$edition-$table.json"
  done
done

# Keys for MCP: Cloud keeps its seed key's text, this edition keeps none, so one is made.
psql_db ratel_cloud -c "select key_plaintext from api_keys where project_id = '$cloud_project' and key_plaintext is not null order by created_at desc limit 1" >"$WORK/keys/cloud"
oss pnpm exec tsx "$HERE/side-by-side/mint-key.mts" "$oss_project" >"$WORK/keys/oss" 2>"$WORK/logs/oss-mint-key.log"

collect flags-off
say "restart both, flags on"
stop_servers
start_servers flags-on
collect flags-on

say "compare"
set +e
node "$HERE/side-by-side/compare.mjs" "$WORK"
status=$?
set -e
echo
echo "side by side: collected output is in $WORK; the report is $WORK/report.txt"
exit "$status"
