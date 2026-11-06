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
| `tasks/` | Tasks: `model` (the list and a task's page), `page-model` (the reads), `queries`, `issues`, `session`, `examples`, `flow-layout`, `status`, `format`, `paths` |
| `fixes/` | Fixes, the one list of changes the pages link an issue to: `build` (the model), `load` (the reads), `select`, `groups`, `effect`, `acted`, `skill-gaps`, `topics`, `copy`, `kinds`, `href`; the Improve → Ship half: `schema` (`fix_experiments`, `fix_shipments`, `fix_shipment_tasks`), `loop-queries` (the experiments declared for a fix and the record that it shipped) and `shipped` (which fixes shipped, derived from those rows) |
| `lineage/` | where each object came from, Monitor → Insights → Improve → Ship: `types` and `refs` (a `LineageRef`, where it opens), `resolve` (one step back, the whole chain, and `recordLineage`), `shipments` and `trail` (the Ship page's list and a shipment's trail), `turn-traces`, `plan`, `stages`, `route` (the lineage endpoint's logic, every boundary injected), `schema` (`lineage_links`). Behind `FF_STAGE_SPINE`, read by `stage-spine-flag.ts`: the Ship page, `GET /api/projects/<id>/lineage`, the rail grouped by stage, the source links and the shipped marks |
| `eval-gate/` | a fix tested before it ships, on the project's own past runs: `service` (the eval set, a simulation, the badge), `store` and `schema` (`fix_eval_sets`, `fix_eval_cases`, `fix_eval_runs`), `runs` (the runs read from the ledger), `simulate` and `ranker` (a re-rank in process), `replay` and `simulation` (the run replayed on a model), `judge`, `score`, `method`, `change`, `defaults`, `models` (the agent, the tool stand-in and the judge, with their budgets), `page-model` and `view` (the eval page), `job` and `register` (`simulate_fix_eval`, run by the worker), `gate` (`FF_EVAL_GATE`), `seams`. With no `ANTHROPIC_API_KEY` there is no model: a re-rank fix still simulates, a fix that needs replay says no model is configured, and nothing calls out; `EVAL_GATE_MOCK_MODEL=1` gives deterministic stand-ins outside production |
| `fix-drafts/` | the drafted text of a rewrite or tell-apart fix, so the eval gate can simulate it: `schema` (`fix_drafts`). The store, the `draft_fix` job and the seam fills land behind `FF_EVAL_GATE` |
| `task-scorers/` | the pure scorer core the eval gate grades a run with: `engine` (`scoreRun`), `outcome`, `replay`, `defaults`, `labels`, `format`, `types`. No table and no model call; the scorers' store, judge and job land with the task loop |
| `freshness/` | where a page's analysis stands: `sections` (the jobs behind each page), `load` (the newest done job and the pending count), `page` (the server's first read), `model` (the poll pacing and the wording) |
| `intents/` | the Intents pages: the topic list and detail (`topics-*`), an intent's breakdown and asks tree (`breakdown*`, `asks-tree`), `hrefs` |
| `intents/map/` | the Map and Flows: membership, placement, geometry, names, outcomes, the tool network and globe, `queries` |
| `home/` | the Overview: `load` (every read in one round, each degrading on its own, assembled into `OverviewData`), `glance` and `glance-queries` (intents, tasks, self-corrections and fixes, one tile each), `attention` (what needs a look now, from the issues, fixes, intents and context), `overview-model` (the window, change figures and context split as plain data) and `queries` (`getProjectHomeEntityCounts`: the skill and experiment counts the MCP project overview opens with) |
| `traces/` | the turn page of Traces, where an Agent health example's "Open in Traces" lands: `turn-detail` (one turn's calls in ledger order, the live query and error text read by event id, a trace link only where Traces holds the trace, the session's neighbouring turns), `turn-detail-linked` (an SDK run's linked OpenTelemetry model calls), `turn-linked` (the linked text, pure) |
| `session-replay/` | one session step by step, read-only: `timeline` (turns, model calls, searches and tool calls in order, with coverage), `load` (its reads), `composition` (what the context held at each model call), `annotations` and `annotations-load` (why each tool choice was good or bad), `view` (rows, decision chips, the page link). Behind `FF_SESSION_REPLAY`, read by `session-replay-flag.ts`; the What-if re-run waits for the eval gate |

## Seams

Readings the pages depend on are read through seams: objects declared here, empty, that a
later module fills (the pattern of `computeSeams` in `readings/trace-signals`): a module's
`register.ts`, or, when the reading is lower than the view, a filler here that the page's
queries import for its side effect. With a seam empty the page renders as upstream minus the
part named below.

| Seam | Filled by | Empty means |
|---|---|---|
| `fixes/seams.ts` `fixSeams.loadDrafts`, `.priceOf`, `.loadRewrites` | filled: the tool crafter's drafts and the round-trip price by `fixes/craft-drafts.ts` (upstream's `craftSeed` and `craftEffect` over `synthesis/tool-crafter`), which `fixes/load.ts` imports for its side effect; match quality's description rewrites by `quality/fix-rewrites.ts` | Fixes lists the issue and intent sources only; `rewritesOn` is false, nothing can be applied or dismissed, no per-run cost |
| `fixes/seams.ts` `fixSeams.recordShipment` | the task loop: marking a shipment live and queuing its tasks for measuring, in one transaction | `createFixShipment` inserts one `fix_shipments` row; `fix_shipment_tasks` stays empty |
| `eval-gate/seams.ts` `evalGateSeams.resolveChange` | fix drafts: the drafted change of a fix, or a queued draft | the gate simulates the change the fix itself carries; a rewrite with no ready text is refused as nothing to simulate |
| `eval-gate/seams.ts` `evalGateSeams.spendSince` | fix drafts, the task loop and What-if: what each spent on models, so they share the one daily budget | the daily budget counts the eval gate's own runs |
| `tasks/seams.ts` `tasksSeams.loadDrafts` | filled: the tool crafter's pending drafts by `fixes/craft-drafts.ts` (upstream's `fixSources`), loaded with `fixes/load.ts`, which `tasks/page-model.ts` imports | a task's page shows no drafted fix |
| `intents/map/seams.ts` `mapSeams.loadToolSteps` | the tool explorer: `intents/map/tool-steps.ts` reads the latest completed run's turn-scope `next` edges (`readings/tool-explorer/queries.ts#listTransitions`) and `map/queries.ts` imports it | the Map draws no "came next" arrows between tools |

`health/imports-types.ts` types the import states (`importing`, `held`, `imported_no_tools`)
that `page-state` keeps reachable only through `imports`, which the pages pass as `null`: the
importer is not part of this edition.

## Owned files

The rest mirror upstream (`scripts/platform-sync/map.json`).

- `health/page-model.ts`: limits come from the entitlements port (no plan table); `page-state.ts`
  and `page-state-copy.ts`: a wider window never names a plan to buy, and no import source is
  named; `page-state.test.ts` accordingly; `ledger-facts-query.ts`: imported turns are found by
  the ledger's source suffix; `mock-fixture.ts`: the development fixture with a neutral tenant;
  `imports-types.ts`: new, see above.
- `tasks/page-model.ts` and `tasks/queries.ts`: the crafter's reads are `tasksSeams` and
  `fixSeams.priceOf`, filled by `fixes/craft-drafts.ts`; `tasks/page-model.integration.test.ts`
  reads a drafted fix onto its task through them.
- `fixes/build.ts`, `fixes/load.ts`, `fixes/seams.ts`, `fixes/crafter-types.ts` (re-exports of
  the crafter's types under the names the fixes model was written against; quality's rewrite
  rows stay here), `fixes/craft-drafts.ts` (new: the crafter's filler, see Seams, with its
  `craft-drafts.test.ts`), `fixes/test-fixtures.ts`, `fixes/build.test.ts`,
  `fixes/load.integration.test.ts`: drafted changes arrive as `DraftFixInput` through the seam;
  the build's craft cases run on `DraftFixInput` fixtures and the filler's on the crafter's cards.
- `fixes/schema.ts`, `lineage/schema.ts`, `eval-gate/schema.ts`, `fix-drafts/schema.ts`: hand-written partitions of the
  upstream schema hub, column for column, because production already has these tables.
  `fixes/loop-queries.ts`: a shipment is one inserted row, the rest is the `recordShipment` seam
  (with its PGlite test `loop-queries.integration.test.ts`). `lineage/lineage.test.ts`: this
  edition has one plan, so only a limit override closes the run behind an insight.
  `stage-spine-flag.ts` (new) replaces upstream's `cloud-stage-spine` flag.
- `eval-gate/gate.ts` (one env switch in place of upstream's per-organization flag, with
  `gate.test.ts`), `models.ts` (calls reported through `platform/model-call`), `store.ts` and
  `service.ts`, `page-model.ts` (the two seams above), `seams.ts`, `register.ts` and
  `no-outbound-without-key.test.ts` (new), and the two integration tests (no plan column; the
  no-key and mock cases with the network cut are at the end of `replay.integration.test.ts`).
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
`fixSeams.loadRewrites` when `fixes/load.ts` loads it. `quality/report-href.ts` (owned, new) is
the link to the printable Quality report, the sibling of `health/report-href.ts`; the
calibration detail offers it, where upstream reaches the report from its admin console.

`calibration/` holds the render tests of the calibration pages' components (the comparison
browser, rows, census tiles, ranking diff, arm mix, and the generic experiment detail's
conversion and lifecycle panels); the components live in `components/console/calibration` and
the read models are `synthesis/experiments` and `synthesis/traces`. Owned: `ranking-ui.test.ts`
(the trace calibration card case is left out; the Traces pages here do not carry that card).
