# `lib/readings/trace-signals` (L4)

The Agent health reading: what a project's closed turns say about its agent. A **signal run**
walks the ledger's closed turns through the detectors, builds claims and persists them as
`trace_signals` (open, resolved, acknowledged) with the finished `trace_signal_runs` row;
**workflows** are the recurring tool sequences mined from those turns, named by a model when a
key is set and placed by the judge; **self-corrections** are the moments the agent backtracked
inside a turn, stored per turn and read as issues by the run. Everything here is derived data:
the next run rewrites it, and nothing stores query text, error text or an end-user id.

| Folder | Holds | Writes |
|---|---|---|
| `signals/` | the detectors (`detect-*`), accumulators, pairs, prerequisites, journey and flow models, the OpenTelemetry facts, the compute pass (`compute.ts`, `compute-job.ts`), the run and signal queries, the analysis context a run reads besides turns | `trace_signal_runs`, `trace_signals`, `trace_turns.workflow_id` |
| `workflows/` | mining (`itemsets`, `mine`, `assign`, `order`, `health`, `detect`), placement (`place`), model names (`label*`), judge decisions (`decide*`) | `trace_workflow_labels`, `trace_workflow_verdicts`, `trace_workflow_insights` |
| `self-corrections/` | the one definition of a retry, switch, give-up, repeated search or repeated ask (`detect`), reply phrases, the per-run reading (`run`, `run-job`, `run-queries`) | `trace_self_corrections` |
| root | the view-model vocabulary the signals are stored in (`view.ts`), claims and their templates, setup facts, the sweep policy and service, `schema.ts`, `register.ts` | — |

**How a run happens.** `compute_trace_signals` is enqueued three ways: the daily sweep
(`trace_signal_sweep`, an after-step of the drain, least-recently-run first), the first reading
once a project has `FIRST_READING_FLOOR` closed turns (the ledger's `onBacklogDrained` seam),
and a reading request carried by a turn build (the `enqueueReading` seam; the health page's
"read now" when it lands). A run reads one window (the organization's limit, up to 90 days,
halved after a time-budget overrun and grown back), claims the project's single live run, and
persists signals and the run in one transaction. After it, the run queues `label_workflows`
when it found workflows and a model key is set, and the readings that follow through
`computeSeams`.

**Model use.** Workflow names need `ANTHROPIC_API_KEY` (`TRACE_WORKFLOW_LABEL_MODEL`, default
`readings/model-defaults.ts`); the placement of recent asks in workflows and the "does any tool
do this" check need `OPENAI_API_KEY` through `readings/decisions` (OpenAI is the one judge
engine in this edition; `TRACE_WORKFLOW_MAX_JUDGE_TOKENS` caps a job's spend). With no key the
run completes, workflows keep their tool-order names, and the label job reports `no_model` and
`no_judge`; nothing leaves the process (`readings/no-outbound-without-key.test.ts`).

**Seams.** `register.ts` fills the ledger's `ledgerSeams` (`enqueueReading`,
`onBacklogDrained`) when the registry loads. `signals/compute-job.ts` exports `computeSeams`:
`enqueueTopics` (the topics registration fills it) and `enqueueExplore` (the tool-explorer
reading, later); unset, a run queues nothing after itself.

**Owned files** (the rest mirror upstream through the sync): `schema.ts`, `register.ts` and
their tests; `view.ts`, `workflows/decide.ts` and `workflows/label-queries.integration.test.ts`
(a comment or fixture named a private engine; back to copies once upstream rewords them);
`workflows/place.ts` and `self-corrections/detect.ts` (a comment named a confidential word);
`signals/compute-job.ts` (no retired flag gate; the follow-on enqueues are seams);
`signals/analysis-context.ts` (the L4 half of upstream's signals ledger module; the closed-turn
readers are `lib/ledger/closed-turns.ts`); `sweep-service.ts` (no gate, no organization read);
`workflows/decide-job.ts` and `decide.test.ts` (OpenAI only; the corpus from the runtime
catalog); `signals/integration-support.ts`, `signals/compute-job.integration.test.ts`,
`signals/linked-runs.integration.test.ts`, `sweep.test.ts` and `workflows/fixed-order.test.ts`
(no flag or page-model cases; the compose-candidate case lands with the tool crafter). The page
read models (`page-model*`, `page-state*`, `tiles`, `flow-*`, `issue-examples`, `ledger-facts*`,
`signals/claims-*`, `signals/story`, the self-corrections page files) are `lib/views/health`;
`turn-detail*` is the turn page of Traces, and `replay*` and `share/` are not part of this
edition.
