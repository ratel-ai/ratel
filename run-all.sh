#!/usr/bin/env bash
# Runs the RP-82 verification logs. Ratel logs -> proof-rp-15/, edition logs -> proof-rp-15-ee/.
set -u
S=$PWD; R=$S/ratel; P=$S/proof-rp-15; E=$S/proof-rp-15-ee; mkdir -p $E
PAIR="ratel 570c00e3 + ratel-platform 8655ce11 (clean trees; ee/src = git archive of 8655ce11); upstream = frozen ratel-cloud 1ce9942f"
L=$P/run-log.sh
T="npx tsx --no-wasm-code-gc --test --test-force-exit"
cd $R/apps/web
$L $P/rp-15-tests.log "RP-15 targeted tests: dimensions ingest, trace filters by agent and MCP server" "$PAIR" "all pass, exit 0" $T lib/ingest/otlp/dimensions/ingest.integration.test.ts lib/ingest/otlp/dimensions/index.test.ts lib/synthesis/traces/trace-filters.integration.test.ts lib/synthesis/traces/v2/filters.test.ts lib/synthesis/traces/span-dimensions.test.ts lib/ingest/otlp/span-events.test.ts
$L $P/rp-16-tests.log "RP-16 targeted tests, FF_TOOL_RUN_INSIGHTS on and off: agent runs as turns, topics, agent tasks, flag" "$PAIR" "all pass, exit 0" $T lib/ledger/turns/agent-run.integration.test.ts lib/ledger/turns/segment-agent-run.test.ts lib/readings/topics/agent-asks.test.ts lib/readings/topics/derived-asks.test.ts lib/readings/topics/job.agent-answered.integration.test.ts lib/readings/topics/job.agent-asks.integration.test.ts lib/readings/topics/job.tool-runs.integration.test.ts lib/readings/trace-signals/signals/agent-tasks.integration.test.ts lib/readings/trace-signals/tool-run-insights.test.ts lib/platform/tool-run-insights-flag.test.ts lib/ingest/otlp/derive-agent-runs.test.ts
RATEL_CAPTURE_ASK=$P/rp-17-captured-ask.json $L $P/rp-17-tests.log "RP-17 targeted tests: job ask allowlist, exported invoke_agent root (captures rp-17-captured-ask.json)" "$PAIR" "all pass, exit 0; the captured span has no project id, user id or customer text" $T lib/jobs/job-ask.test.ts lib/jobs/project-context.test.ts
$L $P/rp-18-tests.log "RP-18 targeted tests: Sessions empty state (#493), draft_task_test fence (#505), codex prices (#558)" "$PAIR" "all pass, exit 0" $T lib/synthesis/traces-sessions/view.test.ts lib/synthesis/traces-sessions/sessions-agreement.integration.test.ts lib/synthesis/traces/v2/sessions-tab-ui.test.ts lib/views/task-evals/run-to-test.integration.test.ts lib/ingest/pricing.test.ts
mv $R/ee/src $R/ee/src.off
$L $P/typecheck-oss.log "OSS typecheck (no ee/src): apps/web tsc --noEmit" "$PAIR" "exit 0" npx tsc --noEmit -p .
mv $R/ee/src.off $R/ee/src
$L $P/typecheck-cloud.log "Cloud typecheck (ee/src present): apps/web tsc --noEmit" "$PAIR" "exit 0" npx tsc --noEmit -p .
cd $R
$L $P/check-boundary.log "pnpm check:boundary" "$PAIR" "exit 0" node scripts/check-ee-boundary.mjs
$L $P/platform-undecided.log "pnpm platform:undecided" "$PAIR" "only Agents/MCP pages files (RP-27); exit 1 while they are undecided" env RATEL_CLOUD_DIR=../ratel-cloud node scripts/platform-sync/undecided.mjs
cd $R/ee
$L $E/cutover.log "cutover.integration.test.ts, synthetic production and ratel-cloud's real migrations to 0110" "$PAIR" "all pass, no drift, exit 0" env RATEL_CLOUD_DIR=$S/ratel-cloud $T src/db/cutover.integration.test.ts
$L $E/rp-18-edition-tests.log "RP-18 edition test: gpt-6-luna general vs Decisions rate" "$PAIR" "all pass, exit 0" $T src/observability/pricing.test.ts
echo DONE
