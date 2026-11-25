# Scorers

A project's own scorers: each one gives every matching trace (or a sample) one stored result,
soon after ingest. Core-owned; not the scorer core of
`views/task-scorers`, which grades a simulated run.

| Table | Holds |
|---|---|
| `trace_scorers` | a scorer, up to 100 per project: kind (`check` or `judge`), config, trace filter, scope (`all` traces, or `tasks`), sample rate, enabled, its own sweep cursor, and how often the judge batch after it failed |
| `trace_scorer_tasks` | the tasks of a scorer of scope `tasks`: read by scorer (the key) and by task (`(project_id, task_id)`). Without a row, such a scorer scores nothing |
| `trace_scores` | one result per scorer and trace (the primary key): `value`, `passed` (null for a numeric judge), `confidence` (judge only), the trace's start. `scorer_id` references `trace_scorers`. No trace content. Removed with the scorer |
| `scorer_judge_spend` | what judge scorers spent per project and UTC day, held reservations included |

| File | What it holds |
|---|---|
| `types.ts` | the domain types: `Scorer`, `ScorerTrace`, `TraceScore`, `ScoreOutcome`. The check vocabulary is `contracts/check`, which the query object uses too |
| `check.ts` | `runCheck`: the pure check engine. A missing value is a skip; only `exists` fails on it |
| `config.ts` | `parseScorerDraft`: a person's settings, checked |
| `schema.ts` | the tables |
| `store.ts` | scorers and results: reads and writes |
| `actions.ts` | `changeScorer`, `testScorer`, `authorizeScorers`: membership, no support session, then the change. A scorer keeps its kind and its answer scale. `attach` to a task narrows a scorer of every trace only with `narrow`; `detach` keeps stored results |
| `sample.ts` | `inSample`: the stable hash of scorer and trace against the sample rate |
| `traces.ts` | the traces as a scorer reads them, the newest matching ones, and their count. A task's traces are those of its turns (`trace_turns.workflow_id`): the turn's `otlp:<trace id>` key, and the `trace_events.trace_id` of its steps |
| `sweep.ts` | `sweepScorers`: per enabled scorer, the trace summaries that settled (45 s without a change) after its cursor: filtered, sampled, scored, stored, and the cursor advanced, in one transaction. A trace received before the scorer was created is not scored. A scorer of tasks scores only up to the latest completed signal run, less the idle window, because that run writes each turn's task. A judge without an engine waits. A judge batch whose every call fails puts the cursor back and is asked again after a wait that doubles from a minute to an hour, `MAX_JUDGE_ATTEMPTS` (24) times in all; then its traces get no result |
| `conversation.ts` | a trace's input and output, read as `get_trace_conversation` reads them; null without captured content, or when the project does not let the product read it |
| `judge.ts` | `judgeTraces`: one closed question per trace to the decision engine (`readings/decisions`), behind `JudgeEngine`. Input and output are cut to 8,000 characters each. The worst cost of a batch is held on the organization's daily budget before any call, then settled. No content, no budget or no answer: the trace gets no result. A failed call is `call_failed`, at its full cost |
| `preview.ts` | `previewScorer`: a draft run on the 5 newest matching traces, nothing stored; `countLastWeek` |
| `task-scores.ts` | `loadTaskScorers`: a task's live scoring on its page, from the scorers attached to it, results of the task's own traces only; `loadAttachableScorers`: the ones it may still get |
| `format.ts` | a scorer and its results in words, and a stored filter as the filter bar's query string |
| `paths.ts` | the console addresses of the Scorers pages and of a trace |
| `metrics.ts` | `scorerMetricSource`: the results as a source of the metric catalog (`synthesis/metrics`). It fills `metricSeams.scores`, because the catalog is a lower layer |
| `funnel.ts` | `runFunnel`: the funnel query kind over traces, with the check engine and the stored results. A value or a result that is not there does not meet its step |
| `spend.ts` | the judge's spend, for the one daily budget (`evalGateSeams.spendSince`) |
| `register.ts` | the drain's `scorers_sweep` step, after `trace_summary_refresh`; one `feature.scorers.swept` event per sweep that did work, and one `feature.scorers.judge_skipped` per scorer the budget stopped |
