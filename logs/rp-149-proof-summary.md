## RP-149 proof (ratel 3baca818, branch beluga/rp-149-evals-tables on #407)

$ tsx --test lib/views/evals/tests/store.integration.test.ts lib/views/scorers/adapters/store.integration.test.ts lib/views/scorers/domain/engine.test.ts
✔ creates an eval with its tasks and reads it back (2509.320375ms)
✔ links tasks many-to-many and lists evals by task and status (268.945542ms)
✔ records a run and its results, upserting a retried result (251.270541ms)
✔ a simulation run needs a fix and a manual run refuses one (221.049917ms)
✔ recent results come from completed runs only, newest first, capped per eval (236.048833ms)
✔ prune clears transcripts older than 30 days and keeps the numbers (215.592125ms)
✔ RC-318: prune clears each turn's message after 30 days, keeps the turn verdicts and numbers, and also prunes a result with turns but no transcript (194.312083ms)
✔ deleting an eval removes its links and results (210.266792ms)
✔ two scorers of one kind on a task, a suite scorer, and one eval's switch (2501.577375ms)
✔ updates validate and bump the version only when the reading changes (260.3015ms)
✔ check reads latency, cost and tokens (1.583208ms)
✔ check reads per-step latency over every step (0.431875ms)
✔ check reads tool called and not called (0.564459ms)
✔ check matches tool arguments and results (0.644917ms)
✔ check reads message text by substring and by pattern (1.153208ms)
✔ check skips an unknown value and reads exists (1.06825ms)
✔ expression evaluates JSONLogic over the run view (0.938667ms)
✔ judge reads the whole transcript through its port (0.699208ms)
✔ decision asks a closed-set question through its port (0.509708ms)
✔ two scorers of one kind both score (0.244292ms)
✔ applicableScorers adds suite scorers and applies the eval's switches (0.181416ms)
✔ the view derives tool names, counts and how the run ended (0.164ms)
✔ parseDefinition rejects an invalid JSONLogic expression with a clear message (0.653542ms)
✔ parseDefinition validates check, judge and decision configs (0.431667ms)
ℹ tests 24
ℹ pass 24
ℹ fail 0

$ tsx --test lib/views/evals/tests/tables.integration.test.ts
✔ suite run settings: empty without a row, set, replaced, and kept per project (1936.178208ms)
✔ nightly settings: one row per project, off by default, removed with the project (221.331084ms)
✔ run scores: live and eval readings, a re-read replaces, daily rates skip skips (199.482834ms)
✔ migration 0055 is a no-op on a database that already has the Evals tables (179.966125ms)
ℹ pass 4
ℹ fail 0

$ node --test scripts/platform-sync/sync.test.mjs  -> pass 39, fail 0
$ sync.mjs --only src/lib/views/{evals,scorers} --check  -> in sync
$ pnpm typecheck -> exit 0; pnpm check:boundary -> 0 violations; pnpm check:private -> clean; pnpm lint -> exit 0
