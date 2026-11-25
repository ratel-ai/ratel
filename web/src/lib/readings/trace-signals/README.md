# `lib/readings/trace-signals` (L4)

The Agent health reading: what a project's closed turns say about its agent. A **signal run**
walks the ledger's closed turns through the detectors, builds claims and persists them as
`trace_signals` (open, resolved, acknowledged) with the finished `trace_signal_runs` row;
**workflows** are the recurring tool sequences mined from those turns, named by a model when a
key is set and placed by the judge; **self-corrections** are the moments the agent backtracked
inside a turn, stored per turn and read as issues by the run; **outcomes** are what each turn,
session and task came to, read behind the `sentimentAnalysis` switch; **hallucinations** are what
the agent made up, read by rules behind the `hallucinationDetection` switch. Everything here is derived data:
the next run rewrites it, and nothing stores query text, error text or an end-user id.

| Folder | Holds | Writes |
|---|---|---|
| `signals/` | the detectors (`detect-*`), accumulators, pairs, prerequisites, journey and flow models, the OpenTelemetry facts, the compute pass (`compute.ts`, `compute-job.ts`), the run and signal queries, the analysis context a run reads besides turns | `trace_signal_runs`, `trace_signals`, `trace_turns.workflow_id` |
| `workflows/` | mining (`itemsets`, `mine`, `assign`, `order`, `health`, `detect`), placement (`place`), model names (`label*`), judge decisions (`decide*`) | `trace_workflow_labels`, `trace_workflow_verdicts`, `trace_workflow_insights` |
| `self-corrections/` | the one definition of a retry, switch, give-up, repeated search or repeated ask (`detect`), reply phrases, the per-run reading (`run`, `run-job`, `run-queries`) | `trace_self_corrections` |
| `outcomes/` | Sentiment analysis's reading (ratel-cloud #553, RC-357), run with each signal run when `sentimentAnalysis` is on for the project's organization: the rule layer reads the trace (`read`, `followed`, `search-runs`, `search-fit` (when no tool a search listed fits it: what "No fitting tool" means), `error-cause`, `tasks`, `rows`, `run`, `run-job`, `run-queries`, `summary`); the model layer puts closed questions about the person's words to an edition's question engine (`questions`, `task-question`, `question-content`, `ask`, `ask-queries`, `model-read`, `reply-reading`, `text-queries`), capped per run and cached by content in `trace_workflow_verdicts`; `fusion` sets the result. `gate.ts` and `questions-gate.ts` are the switch (the page's and the job's). Without `composition.closedQuestions`, or with one that is not configured, nothing is asked and the rows are the rules' and the sentiment lexicon's | `trace_turn_outcomes`, `trace_session_outcomes`, `trace_task_outcomes` |
| `hallucinations/` | Hallucination detection's reading (ratel-cloud #554), run with each signal run when `hallucinationDetection` is on for the project's organization. Rules, no model call and no settings (rule version 2), except `done_but_person_says_not`, which stands on the outcome reading's model answer and is shown as not checked where no model read the window (`views/health/hallucinations/page-model.ts`, `uncheckedKinds`): `detect` reads a turn's steps with their error text (`error-shapes`), the tool each call asked for and the reply (`claims`, `action-class`) into seven kinds in three groups (`kinds`): `unknown_tool`, `tool_rerouted`, `tool_action_changed`; `unknown_reference`, `value_not_allowed`; `claimed_done_after_failure`, `done_but_person_says_not` (a reply that claims completion on a turn the outcome reading stored as `false_success`: a model read the reply as saying done over a failed trace). A runtime's wrapper around a tool's error ("Error executing tool X: …") is read past, and a claim is read only from statements, not questions, conditions or instructions. `run` pages the window, learns aliases (a requested name that ran as one tool in 3 sessions and 5 calls and worked 90% of the time is a name, not a hallucination; kept in the run summary, `summary.hallucinations.aliases`), counts what each group could check, and replaces the window's rows (`run-queries`, `run-job`). `gate.ts` is the switch (the page's, the rail's and the job's) | `trace_hallucinations` |
| root | the view-model vocabulary the signals are stored in (`view.ts`), claims and their templates (with the shared figures, `figures.ts`), the Health score and its pillar math (`health-score.ts`, `health-outcomes.ts`, `health-pillars.ts`), setup facts, the sweep policy and service, `schema.ts`, `register.ts` | — |

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
engine in this edition; `TRACE_WORKFLOW_MAX_JEV_TOKENS`, upstream's name, caps a job's spend,
and `TRACE_WORKFLOW_MAX_JUDGE_TOKENS` is read as an alias). With no key the
run completes, workflows keep their tool-order names, and the label job reports `no_model` and
`no_judge`; nothing leaves the process (`readings/no-outbound-without-key.test.ts`).

**Seams.** `register.ts` fills the ledger's `ledgerSeams` (`enqueueReading`,
`onBacklogDrained`) when the registry loads. `signals/compute-job.ts` exports `computeSeams`:
`enqueueTopics` (the topics registration fills it), `enqueueExplore` (the tool-explorer
reading), `enqueueFixDrafts` (fix drafts, `views/fix-drafts`) and `enqueueTaskScores` (live task
scores, `views/task-scorers`); unset, a run queues nothing
after itself, and a failed enqueue never fails the run.

**Owned files** (they differ from their `ratel-cloud` origin, "upstream"): `schema.ts`, `register.ts` and
their tests; `view.ts`, `workflows/decide.ts` and `workflows/label-queries.integration.test.ts`
(a comment or fixture named a private engine; back to copies once upstream rewords them);
`workflows/place.ts` and `self-corrections/detect.ts` (a comment named a confidential word);
`signals/compute-job.ts` (no retired flag gate; the follow-on enqueues are seams; the outcome
reading runs only with `sentimentAnalysis` on, `outcomesEnabled`, where upstream reads it with
every run);
`signals/analysis-context.ts` (the L4 half of upstream's signals ledger module; the closed-turn
readers are `lib/ledger/closed-turns.ts`); `sweep-service.ts` (no gate, no organization read);
`workflows/decide-job.ts` and `decide.test.ts` (OpenAI only; the corpus from the runtime
catalog); `signals/integration-support.ts`, `signals/compute-job.integration.test.ts`,
`sweep.test.ts` and `workflows/fixed-order.test.ts` (no flag or page-model cases; the
compose-candidate case lands with the tool crafter); `signals/task-scores.integration.test.ts`
(the gate is the `evalGate` flag, set through the config). The page read models (`page-model*`,
`page-state*`, `tiles`, `flow-*`, `issue-examples`, `ledger-facts*`, `signals/claims-*`,
`signals/story`, the self-corrections page files) are `lib/views/health`; `turn-detail*`,
`turn-linked` and `linked-copy.test` (the turn page of Traces) are `lib/views/traces`; `replay*`
and `share/` are not part of this edition.

In `outcomes/`: `gate.ts`, `questions-gate.ts` and their tests (the switch is the core's
`sentimentAnalysis`, read through `featureEnabled`, with upstream's names and arguments);
`run-job.ts` (the engine is `composition.closedQuestions`, `lib/contracts/closed-questions.ts`,
where upstream built its client from the environment); `ask.ts`, `question-content.ts`,
`search-runs.ts` (their limits are `traceOutcomes.*` in `web/src/config.ts`); `questions.ts` (a
comment); `ask.test.ts`, `ask-queries.integration.test.ts`, `model-read.test.ts`,
`model.integration.test.ts` (a neutral model id for the fake engine); `run.test.ts` (the ledger's
page type); `switch.integration.test.ts` (new: the job with the switch off and on). The page
files (`page-*`, `overview`, `example`, `completion-card`) are `lib/views/traces/sentiment` and
`lib/views/health/root-causes`.

In `hallucinations/`: `gate.ts` and its test (the switch is the core's `hallucinationDetection`,
read through `featureEnabled`, with upstream's names and arguments); `detect.test.ts` (neutral
names where fixtures named a customer); `run.test.ts` (the ledger's page type);
`switch.integration.test.ts` (new: the job behind the real gate with `FF_HALLUCINATION_DETECTION`
unset, `0` and `1`). The reading itself needs no core gate of its own: upstream's `run.ts` asks
its `enabled` dep first and returns null, so with the switch off nothing is loaded or written.
The page files (`page-*`, `paths`, `rate-card`, `turn-markers`) are `lib/views/health/hallucinations`.
