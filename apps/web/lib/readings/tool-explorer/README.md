# `lib/readings/tool-explorer` (L4)

The tool explorer: which tools a project's agent calls together and which comes next, read
off the closed turns of the ledger. One `explore_tool_usage` job per reading, queued by every
signal run through `computeSeams.enqueueExplore` (`trace-signals/signals/compute-job.ts`) with
the signal run's id, and coalesced to one queued job per project by the
`jobs_explore_tool_usage_queued_idx` partial index (`lib/jobs/schema.ts`). A run reaps a live
run a crashed job left behind, claims the project's one live run, walks the ledger window in
pages, and persists edges, sets, intent-to-tool shares and the finished run in one transaction;
the previous completed run and its rows go with it, so the fact tables hold one run per project.
It needs no model key and makes no outbound call.

| File | Holds |
|---|---|
| `schema.ts` | `tool_explorer_runs`, `tool_explorer_edges`, `tool_explorer_sets`, `tool_explorer_intent_tools` |
| `job.ts` | `exploreProjectToolUsage`, the job; `parseExplorePayload`; `exploreSeams` (below) |
| `register.ts` | the `explore_tool_usage` job handler; fills `computeSeams.enqueueExplore` when the registry loads |
| `queries.ts` | the run lifecycle, the one-transaction persist, the coalesced enqueue, and the reads: `listTransitions`, `listCousage`, `listMergeCandidates`, `listIntentTools` |
| `compute.ts` | the pass over the ledger (`walkClosedTurnPages`), the window (`explorerWindowDays`: the plan's Agent health window, 30 to 90 days) and the time budget |
| `analyze.ts` | the per-turn accumulators and `finish`, which turns them into the stored result |
| `cousage.ts`, `transitions.ts`, `intents.ts`, `reliability.ts`, `timing.ts` | the arithmetic: frequent itemsets, next/before edges, intent groups and shares, failure rates, hand-off timing (`timing.test.ts` reads the crafter's `pairTiming` and `timingSentences` over it) |
| `thresholds.ts` | `ALWAYS_TOGETHER_LOW`, `SURE_HOP_P`: the bounds the reads and the crafter share |
| `view.ts` | the scope labels and duration formatting the pages and the crafter use |
| `types.ts`, `units.ts` | the row shapes, the summary, and the turn and session units |
| `ledger.ts` | `listSessionTurns`, the intents behind a turn's searches and the error message behind an error step, read from the ledger and the query-intents tables |

**Owned files** (`owned` in `scripts/platform-sync/map.json`): `schema.ts`, the tool-explorer
partition of the upstream schema hub; `job.ts`, with no flag gates (the explorer runs for every
project here, as the signal run does) and the crafter enqueue as a seam; and
`job.integration.test.ts`, without the flag cases. Everything else mirrors upstream. Upstream's
`page-model.ts` is the explorer page's read model and lands with the page.

**Seams.** `job.ts` exports `exploreSeams.enqueueCraft`: the tool crafter (L5,
`synthesis/tool-crafter`) is a reading of this reading, so its registration fills the seam
(`enqueueCraftJob(projectId, undefined, "chained")`), and a completed run queues it. Unset, a
run completes and queues nothing: this module never imports upward. The Intents Map's "came next" arrows (`mapSeams.loadToolSteps`
in `lib/views/intents/map`) are read from this module's turn-scope `next` edges by a filler in
`views` (L6).

Tests: `register.test.ts` (the job kind and the seam fill), `analyze`, `intents`, `reliability`,
`timing` (the arithmetic) and `job.integration.test.ts` (a signal run queues the explorer on PGlite, the
run stores edges and sets for both scopes, replaces the previous run, defers behind a live one,
and completes with the crafter seam empty). Run them with
`npx -y node@24 --import tsx --test --test-force-exit lib/readings/tool-explorer/*.test.ts`
from `apps/web`.
