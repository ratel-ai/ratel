# `lib/readings` (L4)

What the platform reads out of the turn ledger and the raw runtime events: recurring asks,
the adaptive-ranking intent graph and the intent engine's clusters. Every reading is a
registered job plus a drain step; the lexical ones run with no model key, the naming and
judging ones report themselves skipped without one (ADR-0030). Five readings are in: the
three lexical ones, Agent health (signals, workflows, self-corrections) and topics; match
quality and the tool explorer follow.

| Module | Holds | Job / steps |
|---|---|---|
| `intent-types/` | `wire.ts`, the intent graph's wire format (SDK push/pull, validation, ETags, caps); `engine-types.ts`, the engine's cluster, level and assignment shapes | — |
| `text/` | `cluster.ts`, the symmetric-BM25 clusterer the query intents and the engine share | — |
| `decisions/` | `openai.ts`, the OpenAI Decisions client; `engine.ts`, which engine answers closed-set questions (OpenAI only here); `judge.ts`, the judge contract and helpers the readings share (cases, verdicts, corpus entries, option narrowing); `openai-judge.ts`, the one judge engine | — |
| `model-defaults.ts` | `DEFAULT_LABEL_MODEL`, the naming model when the operator sets none | — |
| `stats.ts` | `wilsonInterval`, `CONFIDENT_SCORE_RATIO`: the two statistics the detectors share with the quality meter (L5) | — |
| `match-quality/` | `sweep.ts`: the project rotation the signal sweep reuses; match quality itself is in `synthesis/` | — |
| `tool-explorer/` | `units`, `types`, `reliability`, `transitions`, `timing`: the per-call helpers the signals and self-corrections read; the explorer's own job lands later | — |
| `query-intents/` | `query_intents`, `query_intent_occurrences`: a project's searches folded into canonical recurring asks (`normalize` → `intent-text` → `resolve-canonicals`, `pipeline`) | `categorize_queries`; before-step `query_categorizations_enqueue` (count-based) |
| `intent-graph/` | `intent_graphs`, `_revisions`, `_clusters`, `_edges`, `_shadow_turns`: a runtime's pushed graph and the Cloud-built one (`fold` over the foldable events, `compact`, `maintenance`); the `/api/v1/intent-graph` handlers | `fold_intent_graph`; before-step `intent_graph_fold_enqueue`, retention step `intent_graph_revisions_prune` |
| `intent-engine/` | `intent_engine_state`, `intent_clusters`, `intent_cluster_assignments`: asks clustered by action and object (`engine`, `frames`, `levels`, `compact`, `names`), named with a model key | `cluster_intents`; before-step `intent_engine_enqueue`, retention step `intent_engine_expire` |
| `trace-signals/` | `trace_signal_runs`, `trace_signals`, `trace_workflow_labels`, `_verdicts`, `_insights`, `trace_self_corrections`: signal runs over closed turns (`signals/`), mined workflows with model names and judge decisions (`workflows/`), self-corrections (`self-corrections/`); its own `README.md` | `compute_trace_signals`, `label_workflows`; after-step `trace_signal_sweep` |
| `topics/` | `trace_topics`, `trace_turn_topics`, `trace_topic_insights`: what people ask the agent about, grouped by wording or the judge (`asks`, `group`, `place`), named by a model or from their own words (`evolve`, `name`), with sentiment, flows, stats and tool patterns; its own `README.md` | `assign_topics`, enqueued by each signal run through `computeSeams.enqueueTopics` |

Ingest kicks the fold and the engine, paced (one run per project per five minutes, from
`ingest/trace-events/fold-schedule.ts`); the drain's before-steps are the safety net for a
kick that was lost. The engine reads the fold's rows (`listFoldableTraceEvents`) and the
graph's compaction; the graph never imports the engine.

**Seams.** The ledger's `ledgerSeams` (`enqueueReading`, `onBacklogDrained`) are filled by
`trace-signals/register.ts` when the registry loads. `trace-signals/signals/compute-job.ts`
exports `computeSeams`: `enqueueTopics` (filled by `topics/register.ts`) and
`enqueueExplore` (the tool explorer, later). `intent-graph/fold-job.ts` exports `foldSeams.loadShadow`: the two
tool registries the match-quality reading builds over the project's catalog, for Cloud's own
with-and-without ranking of each search. Unset, the fold builds the graph and stores no
shadow turns. The Boost panel's reads of those turns (`loadBoostSelections` and the outcomes
around live) are in `views/adaptive-ranking`, as the Intents page read models are in `views/intents`
(`breakdown`, `asks-tree`, `setup`, `view`, `v2`). The ledger's own seams are listed in
`lib/ledger/README.md`.

Two guard tests live here: `pure-core.test.ts` (the ledger and the readings import no
framework, page or higher layer) and `no-outbound-without-key.test.ts` (the fold, the
engine, the signal run and the topics reading complete on a seeded database with `fetch`
disabled and no key; naming, workflow names, decisions and topic names make no call). Owned files and why are listed in
`lib/README.md` and in `trace-signals/README.md`.
