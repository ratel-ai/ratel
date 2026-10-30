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
| L3 | `ledger/` | turns, steps, the closed-turn reader (the signal verdict and insight store imports the judge and the workflow labels, so it lands with the trace-signals reading in L4) |
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
