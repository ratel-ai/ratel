# Scorers

A project's own scorers: each one gives every matching trace (or a sample) one stored result,
soon after ingest. Core-owned.

**One model.** This is also a task's live scoring. The 6 measured task kinds of
`views/task-scorers` (`ends_well`, `max_self_corrections`, `max_latency_ms`, `max_cost_usd`,
`expected_tool`, `max_tool_calls`) are scorers of kind `preset`, attached to their tasks: each
trace of a task gets the result that `task-scorers/engine.ts` gives the closed run (`trace_turns`)
the trace belongs to. `judge_criteria` is a pass-or-fail `judge` attached to the task, and the
judge spends from the one daily budget. The scorers the system makes for tasks (created by
`TASK_SCORERS_ACTOR`, the migration's and the seed's) do not count against the limit of scorers:
`countScorers` counts a person's only, so the seed never takes a person's room. Migration `0055`
converts each `task_scorers` row (a preset keeps `enabled`; a judge starts disabled, so nothing
starts to spend; `task_scores_daily` is not converted), and a task with no conversion gets its
defaults once (`task-presets.ts`). The eval gate still grades with
`task-scorers/store.ts#scorersFor`.

**Limit.** The limit of 100 scorers (`MAX_SCORERS`) counts a person's scorers. The sweep scores
every enabled scorer, the system's included. While a project is at or over the limit, each create is refused
with the real count and how many to delete (`format.ts#limitText`, used by `changeScorer`, the
picker and its Panel); update, switch, attach, detach and delete still work.

| Table | Holds |
|---|---|
| `trace_scorers` | a scorer, up to 100 per project: kind (`check`, `judge` or `preset`), config, trace filter, scope (`all` traces, or `tasks`), sample rate, enabled, its own sweep cursor, and how often the judge batch after it failed |
| `trace_scorer_tasks` | the tasks of a scorer of scope `tasks`: read by scorer (the key) and by task (`(project_id, task_id)`). Without a row, such a scorer scores nothing |
| `trace_scores` | one result per scorer and trace (the primary key): `value`, `passed` (null for a numeric judge), `confidence` (judge only), the trace's start. `scorer_id` references `trace_scorers`. No trace content. Removed with the scorer |
| `scorer_judge_spend` | what judge scorers spent per project and UTC day, held reservations included |
| `task_preset_seeds` | what of a task's scorers was already given to the one model: each kind that migration 0055 converted or the seed created, and `*` when the task got its defaults. So each is given once, and a preset a person removes does not come back |

| File | What it holds |
|---|---|
| `types.ts` | the domain types: `Scorer`, `ScorerTrace`, `TraceScore`, `ScoreOutcome`, and `PresetConfig` (a task kind under `preset`, with its setting). The check vocabulary is `contracts/check`, which the query object uses too |
| `check.ts` | `runCheck`: the pure check engine. A missing value is a skip; only `exists` fails on it |
| `config.ts` | `parseScorerDraft`: a person's settings, checked. A preset needs its tasks; a preset draft of `judge_criteria` becomes a pass-or-fail judge |
| `preset.ts` | `scorePresetTraces`: each trace graded with the closed run of the scorer's tasks it belongs to, through `eval-gate/runs.ts#loadRuns` and `engine.ts#scoreRun`; a trace in no closed run, or a run without the measurement, gets none. `definitionOf` and `taskScorerOf` map a task scorer to a scorer and back |
| `task-presets.ts` | `seedTaskPresets`: a recent task without its `*` record gets `scorersFor`'s set (the measured defaults, with what a person stored) once, less the kinds already given or attached, out of the limit; called where `score_tasks` is skipped, the eval gate on or off. The task's `*` record is written first, so two seeds at the same time make each scorer once; a seed error is logged and the eval sets are still queued. The seed gives a judge off. `saveTaskScorer` and `resetTaskScorer`: every write of a task scorer (the task page and MCP `change_task_scorer`) also moves the task's own scorer of that kind (`syncTaskPreset`): one the system made for this one task (`TASK_SCORERS_ACTOR`, attached to the task alone). A scorer a person made, or one shared with other tasks, never changes; the task gets a scorer of its own instead. A save never turns an existing judge on: its switch only goes off, and its sample is at most `TASK_JUDGE_SAMPLE_RATE` (10%, migration 0061 for the converted judges). `updateScorerWithTask`: a Panel or MCP `update_scorer` edit of a task's own scorer writes its setting back to `task_scorers`, which the eval gate grades with; a preset writes its switch too, a judge keeps the gate's switch (its own switch is about live model calls) |
| `schema.ts` | the tables |
| `store.ts` | scorers and results: reads and writes |
| `actions.ts` | `changeScorer`, `testScorer`, `authorizeScorers`: membership, no support session, then the change. A scorer keeps its kind and its answer scale. `attach` to a task narrows a scorer of every trace only with `narrow`; `detach` keeps stored results |
| `sample.ts` | `inSample`: the stable hash of scorer and trace against the sample rate |
| `traces.ts` | the traces as a scorer reads them, the newest matching ones, and their count. A task's traces are those of its turns (`trace_turns.workflow_id`): the turn's `otlp:<trace id>` key, and the `trace_events.trace_id` of its steps |
| `sweep.ts` | `sweepScorers`: per enabled scorer, the trace summaries that settled (45 s without a change) after its cursor: filtered, sampled, scored, stored, and the cursor advanced, in one transaction. A trace received before the scorer was created is not scored. A scorer of tasks scores only up to the latest completed signal run, less the idle window, because that run writes each turn's task. A preset is scored in the batch, as a check is. A preset waits before a trace whose run of its tasks is still open (`openRunTraces`), for `OPEN_RUN_HOLD_MS` (1 hour) after the trace's last change, then passes it with `run_still_open` in the log. A judge without an engine waits. A judge batch whose every call fails puts the cursor back and is asked again after a wait that doubles from a minute to an hour, `MAX_JUDGE_ATTEMPTS` (24) times in all; then its traces get no result |
| `conversation.ts` | a trace's input and output, read as `get_trace_conversation` reads them; null without captured content, or when the project does not let the product read it |
| `judge.ts` | `judgeTraces`: one closed question per trace to the decision engine (`readings/decisions`), behind `JudgeEngine`. Input and output are cut to 8,000 characters each. The worst cost of a batch is held on the organization's daily budget before any call, then settled. No content, no budget or no answer: the trace gets no result. A failed call is `call_failed`, at its full cost |
| `preview.ts` | `previewScorer`: a draft run on the 5 newest matching traces, nothing stored; `countLastWeek` |
| `task-scores.ts` | `loadTaskScorers`: a task's live scoring on its page, from the scorers attached to it, results of the task's own traces only. `offAfterConversion` marks a judge the system made for the task that is off: the page says it makes no model call and offers its switch. The scorers it may still get come from `picker.ts` |
| `picker.ts` | `loadScorerPicker`: what every surface's picker reads, each scorer with its usage (dashboard widgets, alert rules, attached tasks), the count against the limit (`countScorers`, as the server reads it: the system's scorers do not count) and the judge budget left; `UNREAD_SCORERS` when that read fails. `scorerNames`: names only, for what just names a scorer (dashboard writes and exports) |
| `format.ts` | a scorer and its results in words, and a stored filter as the filter bar's query string |
| `paths.ts` | the console addresses of one scorer's page and of a trace. No page lists scorers: `/scorers` and `/scorers/new` redirect to Dashboards (or to the task of `?task=`), `/scorers/<id>/edit` to the scorer's page |
| `metrics.ts` | `scorerMetricSource`: the results as a source of the metric catalog (`synthesis/metrics`). It fills `metricSeams.scores`, because the catalog is a lower layer |
| `funnel.ts` | `runFunnel`: the funnel query kind over traces, with the check engine and the stored results. A value or a result that is not there does not meet its step |
| `spend.ts` | the judge's spend, for the one daily budget (`evalGateSeams.spendSince`) |
| `register.ts` | the drain's `scorers_sweep` step, after `trace_summary_refresh`; one `feature.scorers.swept` event per sweep that did work, and one `feature.scorers.judge_skipped` per scorer the budget stopped |
