# Task scorer core

What "good" means for one simulated run of a task (a kind of job the agent does). The pure core
(`engine`, `outcome`, `replay`, `defaults`, `labels`, `format`, `types`), ported from upstream
`lib/task-scorers`, is what the eval gate grades a simulated run with.

| File | What it holds |
|---|---|
| `store.ts` | `scorersFor`: a task's checks, measured on its own closed runs. No table: nobody edits them |

Live runs are scored by the project's scorers (`views/scorers`, `trace_scores`). The stored per-task
scorers, their daily series and the `score_tasks` job were removed with the `customMonitoring` flag
(migration 0054), with no conversion. A completed signal run queues the due eval sets
(`task-evals/register.ts`).
