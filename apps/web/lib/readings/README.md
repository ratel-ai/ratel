# `lib/readings` (L4)

What the platform reads out of the turn ledger and the raw runtime events: recurring asks,
the adaptive-ranking intent graph and the intent engine's clusters. Every reading is a
registered job plus a drain step; the lexical ones run with no model key, the naming and
judging ones report themselves skipped without one (ADR-0030); the intent names and the
workflow labels also write upstream's `skipped_no_key` model-call line (`model-call-skips.test.ts`). Six readings are in: the
three lexical ones, Agent health (signals, workflows, self-corrections), topics and the tool
explorer; match quality follows.

| Module | Holds | Job / steps |
|---|---|---|
| `intent-types/` | `wire.ts`, the intent graph's wire format (SDK push/pull, validation, ETags, caps); `engine-types.ts`, the engine's cluster, level and assignment shapes | — |
| `text/` | `cluster.ts`, the symmetric-BM25 clusterer the query intents and the engine share; `well-formed.ts`, a cut that never leaves half an emoji in text sent to a model, and `wellFormedJson`, which every Anthropic request in `lib/` goes through (`provider-guards.test.ts` fails on one that does not) | — |
| `decisions/` | `openai.ts`, the OpenAI Decisions client (each question, retries included, is one `model_call` with its feature: `match_quality_judge`, `workflow_decide`, `topics_place`, `topics_sentiment`, else `decision`); `vendors.ts` and `engine.ts`, which vendor answers closed-set questions (`DECISION_PROVIDER`: OpenAI, TypeSafe's Jev, Levanto's Sage, Google's Gemini Decision or a custom server; ADR-0033); `choice.ts`, the client of every one but OpenAI; `resolve.ts`, the judge a surface gets from that vendor (`judgeFromEnv`, which all three surfaces build through); `judge.ts`, the judge contract and helpers the readings share (cases, verdicts, corpus entries, option narrowing); `openai-judge.ts`, the one judge engine | — |
| `labelling/` | adaptive labelling (RC-392): `adaptive` (the stratified share, its margin and the Neyman allocation of the labels still needed, and the audit verdict) and `carry` (a decision kept across an option change while its option is unchanged, behind a re-asked audit); copies. Match quality, topics and the workflow decisions label adaptively, for every project (upstream retired its flag) | none |
| `model-defaults.ts` | `DEFAULT_LABEL_MODEL`, the naming model when the operator sets none | — |
| `stats.ts` | `wilsonInterval`, `CONFIDENT_SCORE_RATIO`: the two statistics the detectors share with the quality meter (L5) | — |
| `match-quality/` | `sweep.ts`: the project rotation the signal sweep reuses; match quality itself is in `synthesis/` | — |
| `tool-explorer/` | `tool_explorer_runs`, `_edges`, `_sets`, `_intent_tools`: which tools run together and which comes next, per turn and per session, read off the closed turns of the signal run's window (`compute`, `analyze`, `cousage`, `transitions`, `intents`); `reliability`, `timing`, `units` are the per-call helpers the signals and self-corrections also read; its own `README.md` | `explore_tool_usage`, enqueued by each signal run through `computeSeams.enqueueExplore` |
| `query-intents/` | `query_intents`, `query_intent_occurrences`: a project's searches folded into canonical recurring asks (`normalize` → `intent-text` → `resolve-canonicals`, `pipeline`) | `categorize_queries`; before-step `query_categorizations_enqueue` (count-based) |
| `intent-graph/` | `intent_graphs`, `_revisions`, `_clusters`, `_edges`, `_shadow_turns`: a runtime's pushed graph and the Cloud-built one (`fold` over the foldable events, `compact`, `maintenance`); the `/api/v1/intent-graph` handlers | `fold_intent_graph`; before-step `intent_graph_fold_enqueue`, retention step `intent_graph_revisions_prune` |
| `intent-graph/catalog-drift.ts`, `catalog-drift-queries.ts`, `prune-gone-tools.ts` | the gone-tool rule (ratel-cloud #474): a tool is gone only when the project's published catalog dropped it and it went unused past the grace period; the facts it reads, and the prune the fold runs on rebuild. Behind `FF_RANKING_CATALOG_DRIFT` (`catalogDriftEnabledForActor`, owned: upstream decides it per organization and person) |
| `intent-graph/bound.ts` | a graph over a store cap is trimmed to its strongest clusters instead of failing the fold (ratel-cloud #456); the fold compacts under pressure past `COMPACT_PRESSURE_CLUSTERS` first |
| `intent-engine/` | `intent_engine_state`, `intent_clusters`, `intent_cluster_assignments`: asks clustered by action and object (`engine`, `frames`, `levels`, `compact`, `names`), named with a model key | `cluster_intents`; before-step `intent_engine_enqueue`, retention step `intent_engine_expire` |
| `trace-signals/` | `trace_signal_runs`, `trace_signals`, `trace_workflow_labels`, `_verdicts`, `_insights`, `trace_self_corrections`: signal runs over closed turns (`signals/`), mined workflows with model names and judge decisions (`workflows/`), self-corrections (`self-corrections/`); its own `README.md` | `compute_trace_signals`, `label_workflows`; after-step `trace_signal_sweep` |
| `trace-signals/partial-reading.ts`, `partial-reading-query.ts`, `inferred-tools-query.ts` | imported runs with no tool calls get a partial reading (their steps, models and failures from what the spans still say) in place of a score; and the share of a window's tool calls inferred from span shape (`ratel.tool.inferred`), which the Ready page states when it is half or more (ratel-cloud #431, #437). `inferred-tools-query.ts` is owned for one comment |
| `topics/` | `trace_topics`, `trace_turn_topics`, `trace_topic_insights`: what people ask the agent about, grouped by wording or the judge (`asks`, `group`, `place`), named by a model or from their own words (`evolve`, `name`), with sentiment, flows, stats and tool patterns; its own `README.md` | `assign_topics`, enqueued by each signal run through `computeSeams.enqueueTopics` |

Ingest kicks the fold and the engine, paced (one run per project per five minutes, from
`ingest/trace-events/fold-schedule.ts`); the drain's before-steps are the safety net for a
kick that was lost. The engine reads the fold's rows (`listFoldableTraceEvents`) and the
graph's compaction; the graph never imports the engine.

**Seams.** The ledger's `ledgerSeams` (`enqueueReading`, `onBacklogDrained`, `onBacklogProgress`) are filled by
`trace-signals/register.ts` when the registry loads. `trace-signals/signals/compute-job.ts`
exports `computeSeams`: `enqueueTopics` (filled by `topics/register.ts`) and
`enqueueExplore` (filled by `tool-explorer/register.ts` with the signal run's id) and
`enqueueFixDrafts` (filled by `views/fix-drafts/register.ts`: drafts for the new rewrite fixes,
behind `FF_EVAL_GATE` and a model key) and `enqueueTaskScores` (filled by
`views/task-scorers/register.ts`: the project's live task scores, behind `FF_EVAL_GATE`).
An `unknown_tool` issue about a tool that exists (in the catalog, or with an ok call in the window: `loadSucceededTools`) is told as missing from the captured tool list and raises no "Build a tool" fix (`trace-signals/signals/unknown-tool-standing.ts`); one whose calls ran costs no Health score points.
`models/` is the model kit (ADR-0033): `models.text(feature)` and `models.chat(feature)` give a
feature the deployment's model for it, whoever serves it, or null. `features.ts` lists every
feature that calls a model. See `models/README.md` before adding a model call. The workflow
labels, the intent names and the topic names get their model there, so they run on whichever
provider the deployment selects; each keeps its `anthropic…` factory, which names a Claude model
outright, for the tests that pin it.

`anthropic/client.ts` (a copy) is the one place the platform gets a Claude client:
`anthropicClient` and `anthropicConfigured`. With `ANTHROPIC_BACKEND` unset, `ANTHROPIC_API_KEY`
selects the Anthropic API. `ANTHROPIC_BACKEND=bedrock` serves every call from Amazon Bedrock
through an EU inference profile with the AWS credential chain and never reads the key; a model
with no EU profile fails as not found, and any other value gives no client. The model kit's
Claude adapter (`models/providers/anthropic.ts`) and the eval gate's Claude code get it through the
kit. Claude on a cloud named as the vendor (`MODEL_PROVIDER=gcp` or `bedrock`) does not come here:
it is `models/providers/claude-hosts.ts`. `pnpm bedrock:smoke`
checks the request shapes against Bedrock with made-up text.
Each completed full reading stores its Health score (`trace-signals/health-score.ts`, RC-225) in
its summary, so the page can show the change. The score (version 2, RC-226) is 60% how the runs
went and 40% the open issues: `trace-signals/health-outcomes.ts` reads five measured rates from
what the reading stored (runs end well, right tool in the top 5, no self-corrections, tasks
finish, calls work), each left out below 20 observations; the score shows on the page and on a public link for every
project. `trace-signals/signals/early-reading.ts` is the
quick first reading (RC-224), for every project: a new project's first run reads
a week, is marked early, and queues the `full_reading` run; a reading made while an import runs
(`composition.importRunning`, the edition's, else its `runningImport`) stays early too.
`tool-explorer/job.ts` exports `exploreSeams.enqueueCraft`: the tool crafter (L5) is a reading
of the explorer's reading, so its registration fills the seam when it lands; unset, a completed
explorer run queues nothing. `intent-graph/fold-job.ts` exports `foldSeams.loadShadow`: the two
tool registries the match-quality reading builds over the project's catalog, for Cloud's own
with-and-without ranking of each search. Unset, the fold builds the graph and stores no
shadow turns. The Boost panel's reads of those turns (`loadBoostSelections` and the outcomes
around live) are in `views/adaptive-ranking`, as the Intents page read models are in `views/intents`
(`breakdown`, `asks-tree`, `setup`, `view`, `v2`). The ledger's own seams are listed in
`lib/ledger/README.md`.

Two guard tests live here: `pure-core.test.ts` (the ledger and the readings import no
framework, page or higher layer) and `no-outbound-without-key.test.ts` (the fold, the
engine, the signal run and the topics reading complete on a seeded database with `fetch`
disabled and no key, and the tool explorer stores its edges from the same ledger; naming, workflow names, decisions and topic names make no call). Owned files and why are listed in
`lib/README.md` and in `trace-signals/README.md`.
