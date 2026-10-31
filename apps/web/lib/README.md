# `apps/web/lib`

The core of the platform application, in layers. A file imports its own layer or a lower one,
never a higher one; nothing here imports the UI (`@/components`, `@/app`) outside tests.
`pnpm check:layers` enforces it ([ADR-0030](../../../docs/adr/0030-platform-oss-layered-core-and-cloud-sync.md)).

| Level | Folder | Holds |
|---|---|---|
| L0 | `contracts/` | the ports: session, entitlements, telemetry, embedding-provider, registry |
| L0 | `adapters/oss/` | one open-source implementation per port |
| L0 | `composition/` | `ports.ts` assembles the ports and imports no module; `registry.ts` collects every module's `register.ts` and is the one root allowed to import any layer |
| L1 | `platform/` | db client and migrator, logger, request log, rate limit, http, otel, environment |
| L1 | `jobs/` | runner, store, drain, scheduler |
| L2 | `ingest/`, `catalog/` | OTLP and runtime-event ingest, catalogs; the catalog contract and skills |
| L3 | `ledger/` | turns, steps, the closed-turn reader |
| L4 | `readings/` | intent engine, intent graph, topics, signals, workflows, self-corrections, match quality, tool explorer, decisions |
| L5 | `synthesis/` | tasks, fixes, health summary, quality, experiments, playground, traces, tool crafter, health imports |
| L6 | `views/`, `console/` | page and view models; scope, navigation, settings, projects, onboarding, seeds |
| L7 | `mcp/` | the MCP operations |

Each module owns its `schema.ts` (tables), `queries.ts` and `register.ts` (job handlers and drain
steps). `platform/db` holds no table; it composes the fragments.

`scripts/layers-allow.json` lists the violations still tolerated while copied code is being
layered. It only shrinks: a stale entry fails the check.

Files maintained here rather than synced from `ratel-cloud` (`owned` in
`scripts/platform-sync/map.json`) keep the upstream export names so call sites stay identical.
In `jobs/` those are the runner (job kinds are open strings), the store (handlers from the
registry), the drain (steps from the registry), the observability seam (telemetry port) and the
scheduler, which has no upstream counterpart. One deliberate exception to the naming rule:
`platform/entitlements.ts` exports `checkEventQuota`, which replaces upstream's
`resetEventUsageIfElapsed` plus the `monthlyEventLimit` comparison in the ingest route, because
the counting edition now does both behind the entitlements port. `incrementEventUsage` keeps its
upstream name and signature.

In `ledger/` the owned files are `constants.ts` (`TURN_EVENT_TYPES` has one source, the
ingest kick; imported sources are recognised by suffix, not an enumerated vendor list),
`hash.ts` (`queryKey` inlined from the L4 match-quality labels), `same-ask.ts` (a comment),
`turns/queries.ts` and `turns/build-job.ts` (no retired feature-flag gate; the run-trigger
vocabulary lives in `run-trigger.ts`; the two seams into the signal runs, `enqueueReading`
and `onBacklogDrained`, are set by the readings' registration instead of imported from L4),
`closed-turns.ts` (the reader half of upstream's `signals/ledger.ts`; the analysis-context
loaders read L4 tables and land with the readings) and the build-job integration test.
Upstream's `workflows/decide-queries.ts` is a workflow concern and lands with the readings.

In `readings/` the owned files are the three schema fragments and three `register.ts` files
(no upstream counterpart), `query-intents/queries.ts` (the query-intents partition of upstream's
queries hub), `intent-graph/queries.ts` (minus the Boost panel block, which reads the L5
quality selections and lands with match quality; plus the fold enqueue and the unfolded-projects
read from the hub), `intent-graph/fold-job.ts` (the shadow replay over the tool catalog is the
`foldSeams.loadShadow` seam the match-quality registration fills, so the fold never imports
match quality), `intent-engine/names-job.ts` (`DEFAULT_LABEL_MODEL` comes from
`readings/model-defaults.ts`, shared with the topic and workflow label jobs), `decisions/engine.ts` (OpenAI is
the one decision engine here; the private engines are excluded), two files with a reworded
comment (`intent-engine/job.ts`, `decisions/openai.ts`) and the tests whose fixtures named a
confidential word, copied with a neutral tenant. `intent-graph/event-types.test.ts` reads the
ingest schema fragment and the single init migration. Deferred with a `$why`: the Intents page
read models (`breakdown*`, `asks-tree`, `setup`, `view`, `v2`) and `boost-view`.

The Agent health reading (`readings/trace-signals/`) adds the shared helpers cut down from
L5 modules: `readings/stats.ts` (the Wilson interval and the confident-score ratio from the
quality metrics), `readings/decisions/judge.ts` and `openai-judge.ts` (the judge contract and
the one engine, from match quality; the sampling and verdict application land with it),
`readings/match-quality/sweep.ts` (the project rotation, run trigger inlined) and, in L2,
`ingest/runtime-catalog/inventory.ts` (the corpus fingerprint and the tool corpus, with the
two searchable-text resolvers inlined; recording fingerprints stays with quality). The two
schema fragments `trace-signals/schema.ts` and `topics/schema.ts` are hand-written partitions
of the upstream schema hub. Each reading's own owned files are listed in its `README.md`
(for topics: `job.ts`, OpenAI only, and `patterns.test.ts`, a fixture with a neutral tenant).
