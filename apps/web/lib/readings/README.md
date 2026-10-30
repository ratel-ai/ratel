# `lib/readings` (L4)

What the platform reads out of the turn ledger and the raw runtime events: recurring asks,
the adaptive-ranking intent graph and the intent engine's clusters. Every reading is a
registered job plus a drain step; the lexical ones run with no model key, the naming and
judging ones report themselves skipped without one (ADR-0030). This slice holds the first
three readings; signals, topics, workflows, self-corrections, match quality and the tool
explorer follow as later slices of the sync.

| Module | Holds | Job / steps |
|---|---|---|
| `intent-types/` | `wire.ts`, the intent graph's wire format (SDK push/pull, validation, ETags, caps); `engine-types.ts`, the engine's cluster, level and assignment shapes | — |
| `text/` | `cluster.ts`, the symmetric-BM25 clusterer the query intents and the engine share | — |
| `decisions/` | `openai.ts`, the OpenAI Decisions client; `engine.ts`, which engine answers closed-set questions (OpenAI only here) | — |
| `model-defaults.ts` | `DEFAULT_LABEL_MODEL`, the naming model when the operator sets none | — |
| `query-intents/` | `query_intents`, `query_intent_occurrences`: a project's searches folded into canonical recurring asks (`normalize` → `intent-text` → `resolve-canonicals`, `pipeline`) | `categorize_queries`; before-step `query_categorizations_enqueue` (count-based) |
| `intent-graph/` | `intent_graphs`, `_revisions`, `_clusters`, `_edges`, `_shadow_turns`: a runtime's pushed graph and the Cloud-built one (`fold` over the foldable events, `compact`, `maintenance`); the `/api/v1/intent-graph` handlers | `fold_intent_graph`; before-step `intent_graph_fold_enqueue`, retention step `intent_graph_revisions_prune` |
| `intent-engine/` | `intent_engine_state`, `intent_clusters`, `intent_cluster_assignments`: asks clustered by action and object (`engine`, `frames`, `levels`, `compact`, `names`), named with a model key | `cluster_intents`; before-step `intent_engine_enqueue`, retention step `intent_engine_expire` |

Ingest kicks the fold and the engine, paced (one run per project per five minutes, from
`ingest/trace-events/fold-schedule.ts`); the drain's before-steps are the safety net for a
kick that was lost. The engine reads the fold's rows (`listFoldableTraceEvents`) and the
graph's compaction; the graph never imports the engine.

**Seams filled later.** `intent-graph/fold-job.ts` exports `foldSeams.loadShadow`: the two
tool registries the match-quality reading builds over the project's catalog, for Cloud's own
with-and-without ranking of each search. Unset, the fold builds the graph and stores no
shadow turns. The Boost panel's reads of those turns (`loadBoostSelections` and the outcomes
around live) land with match quality, as do the Intents page read models
(`breakdown`, `asks-tree`, `setup`, `view`, `v2`). The ledger's own seams are listed in
`lib/ledger/README.md`.

Two guard tests live here: `pure-core.test.ts` (the ledger and the readings import no
framework, page or higher layer) and `no-outbound-without-key.test.ts` (the fold and the
engine complete on a seeded database with `fetch` disabled and no key, and naming makes no
call). Owned files and why are listed in `lib/README.md`.
