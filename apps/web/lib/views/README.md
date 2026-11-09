# `lib/views` (L6)

The read models behind the Agent health, Intents and Traces turn pages, and the improvement
loop's modules that read and write beside them (lineage, a fix's shipments, the eval gate): what each page loads,
in which order, with which fallbacks, and the pure functions that turn rows into the words,
numbers and layouts the components draw. Nothing here imports a component or a page; the pages
(`app/(console)/project/[projectId]/{health,intents,traces/turns}`) and the components land with
the console pages and call into these modules. Export names follow upstream so copied call sites stay
identical.

| Folder | Holds |
|---|---|
| `health/` | the Summary: `page-model` (every read, each one degradable), `page-state` and `page-state-copy` (the state machine: nothing yet, building, too few turns, outside the window, ready, and its copy), `tiles`, `shape-*`, the flow journey (`flow-*`), `ledger-facts*` (what the ledger holds per day), `issue-examples`, `evidence`, `source-mode`, `workflows-view`, `reading-request` |
| `health/signals/` | an issue told as claims (`claims-*`, `story`), the signal rows as the page reads them (`page-view`), the OTel and linked metrics |
| `health/self-corrections/` | the Self-corrections page and card: `page-load`, `page-model`, `page-queries`, `example`, `paths` |
| `health/summary/` | the Summary's links into Fixes and Tasks (`fix-links`, `task-chains`) |
| `tasks/` | Tasks: `model` (the list and a task's page), `page-model` (the reads), `queries`, `issues`, `session`, `examples`, `flow-layout`, `status`, `format`, `paths` (with `topLevelTasksHref`), `live-scores` (each task's overall score today and over 14 UTC days, degrading to "unavailable"). The top-level Tasks pages (`app/(console)/project/[projectId]/tasks`: the list with live scores, a task with its scoring, eval set and run-to-test, its simulations) are behind `FF_STAGE_SPINE`, with the task loop's parts behind `FF_EVAL_GATE`; with the spine on, Agent health › Tasks redirects there |
| `fixes/` | Fixes, the one list of changes the pages link an issue to: `build` (the model), `load` (the reads), `select`, `groups`, `effect`, `acted`, `skill-gaps`, `topics`, `copy`, `kinds`, `href`; the Improve → Ship half: `schema` (`fix_experiments`, `fix_shipments`, `fix_shipment_tasks`), `loop-queries` (the experiments declared for a fix and the record that it shipped) and `shipped` (which fixes shipped, derived from those rows) |
| `lineage/` | where each object came from, Monitor → Insights → Improve → Ship: `types` and `refs` (a `LineageRef`, where it opens), `resolve` (one step back, the whole chain, and `recordLineage`), `shipments` and `trail` (the Ship page's list and a shipment's trail), `turn-traces`, `plan`, `stages`, `route` (the lineage endpoint's logic, every boundary injected), `schema` (`lineage_links`). Behind `FF_STAGE_SPINE`, read by `stage-spine-flag.ts`: the Ship page, `GET /api/projects/<id>/lineage`, the rail grouped by stage, the source links and the shipped marks |
| `eval-gate/` | a fix tested before it ships, on the project's own past runs: `service` (the eval set, a simulation, the badge), `store` and `schema` (`fix_eval_sets`, `fix_eval_cases`, `fix_eval_runs`), `runs` (the runs read from the ledger), `simulate` and `ranker` (a re-rank in process), `replay` and `simulation` (the run replayed on a model), `judge`, `score`, `method`, `change`, `defaults`, `models` (the agent, the tool stand-in and the judge, with their budgets), `page-model` and `view` (the eval page), `job` and `register` (`simulate_fix_eval`, run by the worker), `gate` (`FF_EVAL_GATE`), `seams`. With no `ANTHROPIC_API_KEY` there is no model: a re-rank fix still simulates, a fix that needs replay says no model is configured, and nothing calls out; `EVAL_GATE_MOCK_MODEL=1` gives deterministic stand-ins outside production |
| `fix-drafts/` | the drafted text of a rewrite or tell-apart fix, so the eval gate can simulate it: `schema` (`fix_drafts`), `store` (the newest draft, the reservation, the spend), `resolve` (the change a fix makes, queuing a draft), `model` (Claude Sonnet, or the local stand-in), `job` and `register` (`draft_fix`, run by the worker; fills the eval gate's seams). Behind `FF_EVAL_GATE`; with no `ANTHROPIC_API_KEY` nothing is queued and nothing calls out; `EVAL_GATE_MOCK_MODEL=1` drafts with a stand-in outside production |
| `task-scorers/` | a task's scorers and its live score: the pure core the eval gate also grades a run with (`engine` (`scoreRun`), `outcome`, `replay`, `defaults`, `labels`, `format`, `types`), and the task loop's first half: `schema` (`task_scorers`, `task_scores_daily`), `store` (a task's scorers, its daily scores), `actions` (a person's scorer edits), `job` and `register` (`score_tasks`, queued after a completed signal run through `computeSeams.enqueueTaskScores`), `judge` (the live criteria judge on a daily sample, under the one daily budget). Behind `FF_EVAL_GATE`; with no `ANTHROPIC_API_KEY` the judge is skipped and nothing calls out, the deterministic scorers still run |
| `task-evals/` | a task's eval set, built from its past runs: `schema` (`task_eval_sets`, `task_eval_cases`, `task_eval_runs`, `task_test_drafts`), `selection` (which runs, and why), `store` (`refreshTaskEvalSet`, a set rebuilt under its row lock, pins, edits and exclusions kept), `view`, `actions` (a person's case edits), `test-proposal`, `job` and `register` (`refresh_task_eval_set`: queued after live scoring for sets a week old, or on request, coalesced per task; `simulate_task_eval`: one queued simulation of a fix on a task's set, or a post-ship measure, one live run per fix, task and kind), `simulation` (`runTaskSimulation`: one run per task of the fix, its change frozen with the cases and scorers; the reservation under the daily budget), `simulation-job` (the run replayed or re-ranked and scored before and after, per scorer, with a verdict), `simulation-view`, `simulation-page` and `simulation-actions` (the simulations page: a run's state, stale after an edit, and a person's edits), `post-ship` (after a fix ships, the task's live runs measured for up to 7 days or 20 runs, and a verdict), `ship` (the shipment record: with the gate on, marked live and its tasks queued for measuring in one transaction), `spend` (the task loop's share of the daily budget). `run-to-test` and `draft-action` (a past run drafted into a test by a small model, reserved under the daily budget, `task_test_drafts`). Behind `FF_EVAL_GATE`; with no `ANTHROPIC_API_KEY` a simulation reserves nothing and scores deterministically, with no replay or judge, and run-to-test says no model is configured; nothing calls out |
| `freshness/` | where a page's analysis stands: `sections` (the jobs behind each page), `load` (the newest done job and the pending count), `page` (the server's first read), `model` (the poll pacing and the wording) |
| `intents/` | the Intents pages: the topic list and detail (`topics-*`), an intent's breakdown and asks tree (`breakdown*`, `asks-tree`), `hrefs` |
| `intents/map/` | the Map and Flows: membership, placement, geometry, names, outcomes, the tool network and globe, `queries` |
| `home/` | the Overview: `load` (every read in one round, each degrading on its own, assembled into `OverviewData`), `glance` and `glance-queries` (intents, tasks, self-corrections and fixes, one tile each), `attention` (what needs a look now, from the issues, fixes, intents and context), `overview-model` (the window, change figures and context split as plain data) and `queries` (`getProjectHomeEntityCounts`: the skill and experiment counts the MCP project overview opens with) |
| `traces/` | the turn page of Traces, where an Agent health example's "Open in Traces" lands: `turn-detail` (one turn's calls in ledger order, the live query and error text read by event id, a trace link only where Traces holds the trace, the session's neighbouring turns), `turn-detail-linked` (an SDK run's linked OpenTelemetry model calls), `turn-linked` (the linked text, pure) |
| `session-replay/` | one session step by step, read-only: `timeline` (turns, model calls, searches and tool calls in order, with coverage), `load` (its reads), `composition` (what the context held at each model call), `annotations` and `annotations-load` (why each tool choice was good or bad), `view` (rows, decision chips, the page link). What-if, a step forked with one change and sampled before and after: `variant` (the change), `fork` (the engine, over the eval gate's replay), `runs` (`requestWhatIf` under the daily budget, the content opt-in, `pruneWhatIfRuns`), `job` and `register` (`what_if_step`, run by the worker, and the drain's `what_if_prune`, which runs with retention off so a timed-out run frees its hold), `spend` (its share of the budget), `schema` (`session_replay_runs`, `session_replay_settings`), `gate`. Behind `FF_SESSION_REPLAY`, read by `session-replay-flag.ts`. No page yet: upstream has no What-if UI. With no `ANTHROPIC_API_KEY` a replay run fails with no model and nothing calls out; without the content opt-in (off unless set) a run re-ranks and calls no model |

## Seams

Readings the pages depend on are read through seams: objects declared here, empty, that a
later module fills (the pattern of `computeSeams` in `readings/trace-signals`): a module's
`register.ts`, or, when the reading is lower than the view, a filler here that the page's
queries import for its side effect. With a seam empty the page renders as upstream minus the
part named below.

| Seam | Filled by | Empty means |
|---|---|---|
| `fixes/seams.ts` `fixSeams.loadDrafts`, `.loadDraftWindows`, `.priceOf`, `.loadRewrites`, `.loadOverrideAdoption` | filled: the tool crafter's drafts (each with its gain: the calls, tokens, cost and waiting it saves), the days of runs each crafter run measured and the round-trip price by `fixes/craft-drafts.ts` (upstream's `craftSeed` over `synthesis/tool-crafter`), which `fixes/load.ts` imports for its side effect; match quality's description rewrites and, in a read of its own, the override adoption by `quality/fix-rewrites.ts`. `fixes/load.ts` runs each in its own resilient read, so a failed window or adoption read costs a rate or a caveat, never the drafts or the rewrites | Fixes lists the issue and intent sources only; `rewritesOn` is false, nothing can be applied or dismissed, no per-run cost |
| `fixes/seams.ts` `fixSeams.recordShipment` | filled: `task-evals/ship.ts` (upstream's gate-on branch of `createFixShipment`), loaded by the task-evals registration, the MCP loop tools and the simulations page: with `FF_EVAL_GATE` on, the shipment is marked live and its tasks queued for measuring, in one transaction; `createFixShipment`'s `deps` (upstream's) reach it | `createFixShipment` inserts one `fix_shipments` row; `fix_shipment_tasks` stays empty |
| `eval-gate/seams.ts` `evalGateSeams.resolveChange` | filled: fix drafts' `resolveFixChange` by `fix-drafts/register.ts`, which `eval-gate/service.ts` and `page-model.ts` import for its side effect: a ready draft's change, or a queued draft ("being prepared"), or, with no model key, a refusal that says so | the gate simulates the change the fix itself carries; a rewrite with no ready text is refused as nothing to simulate |
| `eval-gate/seams.ts` `evalGateSeams.spendSince` | fix drafts (filled by `fix-drafts/register.ts`), What-if (`session-replay/spend.ts`, loaded by its `register.ts` and `runs.ts`) and the task loop (`task-evals/spend.ts`, loaded by both task-loop registrations, `task-scorers/judge.ts` and `task-evals/simulation.ts`: the live judge's daily spend, task simulations and post-ship measures (running ones at what they hold), and drafted tests (held reservations too)): what each spent on models, so they share the one daily budget | the daily budget counts the eval gate's own runs |
| `tasks/seams.ts` `tasksSeams.loadDrafts` | filled: the tool crafter's pending drafts by `fixes/craft-drafts.ts` (upstream's `fixSources`), loaded with `fixes/load.ts`, which `tasks/page-model.ts` imports | a task's page shows no drafted fix |
| `intents/map/seams.ts` `mapSeams.loadToolSteps` | the tool explorer: `intents/map/tool-steps.ts` reads the latest completed run's turn-scope `next` edges (`readings/tool-explorer/queries.ts#listTransitions`) and `map/queries.ts` imports it | the Map draws no "came next" arrows between tools |

`health/imports-types.ts` types the import states (`importing`, `held`, `imported_no_tools`)
that `page-state` keeps reachable only through `imports`, which the pages pass as `null`: the
importer is not part of this edition.

## Owned files

The rest mirror upstream (`scripts/platform-sync/map.json`).

- `health/page-model.ts`: limits come from the entitlements port (no plan table); `page-state.ts`
  and `page-state-copy.ts`: a wider window never names a plan to buy, and no import source is
  named; `page-state.test.ts` accordingly; `mock-fixture.ts`: the development fixture with a neutral tenant;
  `imports-types.ts`: new, see above.
- `tasks/tasks-ui.test.ts` and the components `TasksView` and `TaskSections` are copies again: the
  live scores, run-to-test and session replay links they carried land with the task loop.
- `tasks/page-model.ts` and `tasks/queries.ts`: the crafter's reads are `tasksSeams` and
  `fixSeams.priceOf`, filled by `fixes/craft-drafts.ts`; `tasks/page-model.integration.test.ts`
  reads a drafted fix onto its task through them.
- `fixes/build.ts`, `fixes/load.ts`, `fixes/seams.ts`, `fixes/crafter-types.ts` (re-exports of
  the crafter's types under the names the fixes model was written against; quality's rewrite
  rows stay here), `fixes/craft-drafts.ts` (new: the crafter's filler, see Seams, with its
  `craft-drafts.test.ts`), `fixes/test-fixtures.ts`, `fixes/build.test.ts`,
  `fixes/load.integration.test.ts`: drafted changes arrive as `DraftFixInput` through the seam;
  the build's craft cases run on `DraftFixInput` fixtures and the filler's on the crafter's cards.
  Savings are upstream's (#323): `fixes/period.ts`, `fixes/usage.ts` and `fixes/select.ts` are
  copies; the build tells a draft's gain as its effect ("−10k tokens · −$0.40 · −4 s waiting per
  month") and ranks a draft whose replay came out worse last; the load reads each task's usage
  (stored with the task's reading, else live) for the shares in Savings by task.
- `fixes/schema.ts`, `lineage/schema.ts`, `eval-gate/schema.ts`, `fix-drafts/schema.ts`: hand-written partitions of the
  upstream schema hub, column for column, because production already has these tables.
  `fixes/loop-queries.ts`: a shipment is one inserted row, the rest is the `recordShipment` seam
  (with its PGlite test `loop-queries.integration.test.ts`); `createFixShipment` takes upstream's
  `deps` and hands them to the seam. `lineage/lineage.test.ts`: this
  edition has one plan, so only a limit override closes the run behind an insight.
  `stage-spine-flag.ts` (new) replaces upstream's `cloud-stage-spine` flag.
- `eval-gate/gate.ts` (one env switch in place of upstream's per-organization flag, with
  `gate.test.ts`), `models.ts` (calls reported through `platform/model-call`), `store.ts` and
  `service.ts`, `page-model.ts` (the two seams above), `seams.ts`, `register.ts` and
  `no-outbound-without-key.test.ts` (new), and the two integration tests (no plan column; the
  no-key and mock cases with the network cut are at the end of `replay.integration.test.ts`).
- The task loop (`task-scorers/`, `task-evals/`): `schema.ts` (the two partitions, column for
  column) and `register.ts` (new); `task-scorers/job.ts`, `task-evals/store.ts` and their
  integration tests (`job`, `refresh`): the gate is `FF_EVAL_GATE`, so the `flagDeps` upstream
  hands its flag service are the environment the gate reads (`OrganizationFlagDeps` in
  `task-evals/store.ts`), keeping the copied callers unchanged; `task-scorers/judge.ts`: the
  budget lock is `lockOrganizationSpend`, as in `task-evals/simulation.ts` and `post-ship.ts`
  (and `simulation.ts` passes its `flagDeps` to the draft lookup as `env`, which
  `eval-gate/seams.ts` carries); `task-evals/spend.ts` (new: upstream sums the task loop's spend
  inline in `organizationModelSpendSince`), `task-evals/ship.ts` (new: upstream's gate-on
  branch of `createFixShipment`) and `task-evals/no-outbound-without-key.test.ts` (new); the
  `simulation`, `simulation-actions` and `post-ship` integration tests (the env gate; a shipment
  through `./ship`); `task-evals/run-to-test.ts` (the env gate and `lockOrganizationSpend`) and its
  integration test. The top-level Tasks pages own `page.tsx`, `[taskId]/page.tsx`,
  `[taskId]/actions.ts`, `simulations/context.ts` and `simulations/actions.ts`: the project comes
  from the console scope, and the stage spine and session replay are the env flags.
- `intents/map/queries.ts`: the tool-step read is `mapSeams.loadToolSteps`, filled by
  `intents/map/tool-steps.ts` (new: upstream's `loadToolSteps` body and `TOOL_STEP_READ_LIMIT`,
  with its PGlite test `tool-steps.integration.test.ts`); `intents/hrefs.ts`:
  `capabilityCatalogHref` on its own (the rest of upstream's file is the adaptive-ranking page
  view).
- `home/queries.ts`: the home-recap partition of upstream's queries hub (`getProjectHomeEntityCounts`),
  with its PGlite test `home/queries.integration.test.ts`; `home/load.ts`: no feature-flag gate
  (Agent health is always on, so its read runs with the rest), and the issue anchor spelled
  inline, since `lib/` never imports the UI.
- `session-replay/load.test.ts` and `annotations-load.test.ts`: the organization fixture has no
  plan column. `session-replay-flag.ts` (new) replaces upstream's organization flag gate.
- `session-replay/gate.ts`: upstream's `sessionReplayEnabledForActor` over `FF_SESSION_REPLAY`,
  with its test. `runs.ts` and `job.ts` take the gate's dependencies from it; `runs.ts` also
  takes the budget lock as an advisory lock on the organization id (the edition owns
  `organizations`) and loads `spend.ts`. `spend.ts` (upstream's What-if term of
  `organizationModelSpendSince`), `register.ts` and `schema.ts` are this module's parts of
  upstream hubs. `runs.test.ts` reads this repository's migration; `runs.integration.test.ts`
  has no plan column and an env flag. `no-outbound-without-key.test.ts` is new.
- Tests whose fixtures named a confidential word, copied with a neutral tenant:
  `health/flow-journey-layout.test.ts`, `intents/topics-view.test.ts`, `intents/map/{classify,
  flow,map-model,tool-globe}.test.ts` and `intents/map/tool-network-fixture.ts`.

The render tests of the Intents pages sit here too (`intents/intents-ui.test.ts`, owned without
the adaptive-ranking cases, and `intents/map/{intent-map,tool-network}-ui.test.ts`).

Not here, with a `$why` in the map: the public share links and the v1 Summary components they
alone use, the health importer, the Boost panel (adaptive ranking), and the render tests, which
import components and land with the pages (`traces/turn-detail.test.ts` is upstream's file as
is, half model and half render, so it stays beside its model).

Fix leads point at `/improvement/fixes` and `/quality/descriptions`, as upstream does.

`adaptive-ranking/` holds the Adaptive ranking page's read models and the Boost reads.

`quality/` holds the Quality pages' read models. `quality/fix-rewrites.ts` fills
`fixSeams.loadRewrites` and `fixSeams.loadOverrideAdoption` when `fixes/load.ts` loads it. `quality/report-href.ts` (owned, new) is
the link to the printable Quality report, the sibling of `health/report-href.ts`; the
calibration detail offers it, where upstream reaches the report from its admin console.

`calibration/` holds the render tests of the calibration pages' components (the comparison
browser, rows, census tiles, ranking diff, arm mix, and the generic experiment detail's
conversion and lifecycle panels); the components live in `components/console/calibration` and
the read models are `synthesis/experiments` and `synthesis/traces`. Owned: `ranking-ui.test.ts`
(the trace calibration card case is left out; the Traces pages here do not carry that card).
