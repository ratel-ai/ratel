# `lib/ledger` (L3)

The turn ledger: raw runtime events (`trace_events`, from L2 ingest) folded into durable
*turns* (one user ask and everything the agent did in answer) and their *steps* (each search
or invocation). Every reading above (the intent engine, signals, topics) works from closed
turns, never from raw events, so a 90-day window survives the 30-day event prune.

| Path | Holds |
|---|---|
| `schema.ts` | `trace_turns`, `trace_turn_steps`; the build cursor is `projects.trace_turns_built_through` |
| `types.ts`, `constants.ts` | the turn and step shapes; the boundary thresholds (`TRACE_TURNS_*` env), `TURN_EVENT_TYPES` re-exported from the ingest kick |
| `hash.ts` | salted hashes of a query and an end user; the ledger stores neither in the clear (`TRACE_SIGNALS_HASH_SALT`) |
| `same-ask.ts` | whether two searches ask for the same thing: the retry, detour and first-try rules |
| `turns/` | the pure pipeline (`normalize` → `segment` → `attribute` → `aggregate`, driven by `build-turn`), its queries, and `build-job` |
| `closed-turns.ts`, `turn-pages.ts` | the reader the readings use: closed turns paged by `(ended_at, id)` with their steps, under a time budget |
| `run-trigger.ts` | why a signal run was asked for; a queued build may carry such a request |
| `register.ts` | the `build_trace_turns` job and the `trace_turns_build_enqueue` before-step |

Three kicks start a build: the traces and events routes after a stored batch (then a
post-response drain), the drain's before-step for projects with unbuilt events or idle open
turns, and a reading request from the health pages (later). A turn closes when the next
one starts, on a gap or cap, or when its session has been quiet for 30 minutes.

**Seams the readings fill (step 9).** `build-job.ts` exports `ledgerSeams`: `enqueueReading`
(the signal run a request asked for) and `onBacklogDrained` (the first-reading enqueue once
the ledger has enough closed turns). The trace-signals registration sets them; the ledger
never imports L4. Owned files and why are listed in `lib/README.md`.
