# Task scorers

What "good" means for one task (a kind of job the agent does), and how its live runs score
against it each day. Ported from upstream `lib/task-scorers`. The pure core (`engine`,
`outcome`, `replay`, `defaults`, `labels`, `format`, `types`) is also what the eval gate grades a
simulated run with; the rest is the first half of the task loop and runs only when the eval gate
is on (`FF_EVAL_GATE`, `eval-gate/gate.ts`).

| File | What it holds |
|---|---|
| `schema.ts` | `task_scorers` (a task's scorers: kind, config, enabled, `default` or `user`, version) and `task_scores_daily` (per UTC day and scorer kind, plus `overall`: runs scored and passed, and the live judge's `judge_spend`). The task-scorers partition of the upstream schema hub, column for column, because production already has the tables |
| `store.ts` | `scorersFor` (the task's defaults until a person edits one), `upsertScorer`, `resetScorer`, `dailyScoresFor`, `upsertDailyScores` |
| `actions.ts` | a person's scorer changes, checked and applied (the pages' server action calls it) |
| `job.ts` | `scoreTasksJob` (the `score_tasks` handler: every closed run of each task scored by UTC day, today's judged by `judge.ts`, then the due eval sets queued) and `enqueueScoreTasksJob` |
| `judge.ts` | `judgeTaskSample`: a `judge_criteria` scorer judged on a daily sample (`TASK_JUDGE_SAMPLE`, 20) under its own cap (`TASK_JUDGE_BUDGET_USD`, $0.50) and the organization's daily budget, reserved before any call |
| `register.ts` | the `score_tasks` registration, and the fill of `computeSeams.enqueueTaskScores`: a completed signal run queues the project's live scores |

With no `ANTHROPIC_API_KEY` the judge is skipped (no row, no call) and the deterministic scorers
still write their counts; `EVAL_GATE_MOCK_MODEL=1` judges with a rule stand-in outside
production. As upstream, `score_tasks` is not coalesced: each completed signal run queues one.

**Owned (ADR-0030).** `schema.ts` and `register.ts`; `job.ts` and `job.integration.test.ts` (the
gate is the `FF_EVAL_GATE` env value, carried in upstream's `flagDeps`); `judge.ts` (the core has
no `organizations` table, so the budget lock is `eval-gate/store.ts#lockOrganizationSpend`, and
it loads `task-evals/spend.ts` so the budget counts the judge). The rest are copies.
