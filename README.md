# Proof: port of ratel-cloud's post-sync changes (RP-15 to RP-18, RP-81, RP-82)

Code pair: **ratel 570c00e3** (branch `beluga/rp-17-job-ask-allowlist`, baseline f6f918d9) and
**ratel-platform 8655ce11** (branch `beluga/rp-17-port-ratel-cloud-s`). Upstream: the frozen
ratel-cloud main **1ce9942f**. Run on 2026-11-21 with `run-all.sh`. The RP-81 logs are from ratel e47daefa: RP-82 changed only one test fixture after them. Each log starts with its date,
the code pair, the command and the expected result, and ends with the exit code. No full suite was run.

| File | What it shows | Result |
|---|---|---|
| `cutover.log` | `db/cutover.integration.test.ts` on synthetic production and on ratel-cloud's real migrations to 0110 (`RATEL_CLOUD_DIR`): core 0039–0042 record upstream 0106/0107/0109/0110 | 38 pass, 0 skipped, no drift |
| `rp-15-tests.log` | RP-15: entity dimensions stored at ingest, Traces filters by agent and MCP server, span events and links | 75 pass |
| `rp-16-tests.log` | RP-16: agent runs as turns, agent tasks, derived and agent asks, `FF_TOOL_RUN_INSIGHTS` on and off | 45 pass |
| `rp-17-tests.log` | RP-17: job asks from the allowlist only; the exported `invoke_agent` root | 16 pass |
| `rp-17-captured-ask.json` | RP-17: the captured span for a `draft_fix` job whose payload had a project id, a user id and customer text | none of them is sent |
| `rp-18-tests.log` | RP-18: Sessions empty state (#493), draft_task_test JSON fence (#505), Codex prices (#558) in the core | 57 pass |
| `rp-18-edition-tests.log` | RP-18: the edition's `gpt-6-luna` general rate vs Decisions rate | 2 pass |
| `typecheck-oss.log` | `apps/web` `tsc --noEmit` without `ee/src` (Ratel OSS) | exit 0 |
| `typecheck-cloud.log` | `apps/web` `tsc --noEmit` with `ee/src` (Ratel Cloud) | exit 0 |
| `check-boundary.log` | `pnpm check:boundary` | exit 0 |
| `platform-undecided.log` | `pnpm platform:undecided` | 36 undecided, all Agents/MCP pages (RP-27); exit 1 until RP-27 decides them |
| `rp-81-undecided.log` | RP-81: the same at ratel e47daefa | as above |
| `rp-81-map-coverage.log` | RP-81: each file changed f6f918d9..e47daefa and its map.json entry (`map-coverage.mjs`) | 204 files; the 2 uncovered are `biome.json` and `source.json`, sync tool files |
| `rp-81-sync-check.log` | RP-81: `platform:sync --check` against 1ce9942f | pending only RP-27, RP-10 and the #509 test |

`run-log.sh` writes each log. `run-all.sh` is the script that made this run.
