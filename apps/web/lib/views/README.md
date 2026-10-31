# `lib/views` (L6)

The read models behind the Agent health and Intents pages: what each page loads, in which
order, with which fallbacks, and the pure functions that turn rows into the words, numbers and
layouts the components draw. Nothing here imports a component or a page; the pages
(`app/(console)/project/[projectId]/{health,intents}`) and the components land with the console
pages and call into these modules. Export names follow upstream so copied call sites stay
identical.

| Folder | Holds |
|---|---|
| `health/` | the Summary: `page-model` (every read, each one degradable), `page-state` and `page-state-copy` (the state machine: nothing yet, building, too few turns, outside the window, ready, and its copy), `tiles`, `shape-*`, the flow journey (`flow-*`), `ledger-facts*` (what the ledger holds per day), `issue-examples`, `evidence`, `source-mode`, `workflows-view`, `reading-request` |
| `health/signals/` | an issue told as claims (`claims-*`, `story`), the signal rows as the page reads them (`page-view`), the OTel and linked metrics |
| `health/self-corrections/` | the Self-corrections page and card: `page-load`, `page-model`, `page-queries`, `example`, `paths` |
| `health/summary/` | the Summary's links into Fixes and Tasks (`fix-links`, `task-chains`) |
| `tasks/` | Tasks: `model` (the list and a task's page), `page-model` (the reads), `queries`, `issues`, `session`, `examples`, `flow-layout`, `status`, `format`, `paths` |
| `fixes/` | Fixes, the one list of changes the pages link an issue to: `build` (the model), `load` (the reads), `select`, `groups`, `effect`, `acted`, `skill-gaps`, `topics`, `copy`, `kinds`, `href` |
| `intents/` | the Intents pages: the topic list and detail (`topics-*`), an intent's breakdown and asks tree (`breakdown*`, `asks-tree`), `hrefs` |
| `intents/map/` | the Map and Flows: membership, placement, geometry, names, outcomes, the tool network and globe, `queries` |

## Seams

Three readings this edition does not ship yet are read through seams: objects declared here,
empty, that a later module's `register.ts` fills (the pattern of `computeSeams` in
`readings/trace-signals`). With every seam empty the pages render as upstream minus the parts
named below.

| Seam | Filled by | Empty means |
|---|---|---|
| `fixes/seams.ts` `fixSeams.loadDrafts`, `.loadRewrites`, `.priceOf` | the tool crafter (drafts and the round-trip price) and match quality (description rewrites) | Fixes lists the issue and intent sources only; `rewritesOn` is false, nothing can be applied, no per-run cost |
| `tasks/seams.ts` `tasksSeams.loadDrafts` | the tool crafter | a task's page shows no drafted fix |
| `intents/map/seams.ts` `mapSeams.loadToolSteps` | the tool explorer | the Map draws no "came next" arrows between tools |

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
  `fixSeams.priceOf`.
- `fixes/build.ts`, `fixes/load.ts`, `fixes/seams.ts`, `fixes/crafter-types.ts` (structural
  stand-ins for the crafter's and quality's types, re-exports once they land),
  `fixes/test-fixtures.ts`, `fixes/build.test.ts`, `fixes/load.integration.test.ts`: drafted
  changes arrive as `DraftFixInput` through the seam; the crafter's own cases live with it.
- `intents/map/queries.ts`: `mapSeams.loadToolSteps`; `intents/hrefs.ts`: `capabilityCatalogHref`
  on its own (the rest of upstream's file is the adaptive-ranking page view).
- Tests whose fixtures named a confidential word, copied with a neutral tenant:
  `health/flow-journey-layout.test.ts`, `intents/topics-view.test.ts`, `intents/map/{classify,
  flow,map-model,tool-globe}.test.ts` and `intents/map/tool-network-fixture.ts`.

The render tests of the Intents pages sit here too (`intents/intents-ui.test.ts`, owned without
the adaptive-ranking cases, and `intents/map/{intent-map,tool-network}-ui.test.ts`).

Not here, with a `$why` in the map: the public share links and the v1 Summary components they
alone use, the health importer, the turn detail (it is the turn page of Traces), the Boost
panel (adaptive ranking), and the render tests, which import components and land with the pages.

Fix leads still point at `/improvement/fixes` and `/quality/descriptions`, as upstream does;
those routes redirect to the Summary and the Catalog until the Fixes and Quality pages land.
