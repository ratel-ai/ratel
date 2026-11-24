# Scorers

A project's own scorers: each one gives every matching trace (or a sample) one stored result,
soon after ingest. Behind the `scorers` flag. Core-owned; not the task scorers of
`views/task-scorers`, which score a task's runs per day.

| Table | Holds |
|---|---|
| `scorers` | a scorer: kind (`check` or `judge`), config, trace filter, sample rate, enabled, and its own sweep cursor |
| `trace_scores` | one result per scorer and trace (the primary key): `value`, `passed` (null for a numeric judge), `confidence` (judge only), the trace's start. No trace content. Removed with the scorer |
| `scorer_judge_spend` | what judge scorers spent per project and UTC day, held reservations included |

| File | What it holds |
|---|---|
| `types.ts` | the domain types: `Scorer`, `ScorerTrace`, `TraceScore`, `ScoreOutcome` |
| `check.ts` | `runCheck`: the pure check engine. A missing value is a skip; only `exists` fails on it |
| `config.ts` | `parseScorerDraft`: a person's settings, checked |
| `schema.ts` | the tables |
| `store.ts` | scorers and results: reads and writes |
| `actions.ts` | `changeScorer`, `authorizeScorers`: membership, the flag, then the change. A scorer keeps its kind and its answer scale |
| `sample.ts` | `inSample`: the stable hash of scorer and trace against the sample rate |
| `traces.ts` | the traces as a scorer reads them, the newest matching ones, and their count |
| `sweep.ts` | `sweepScorers`: per enabled scorer, the trace summaries that settled (45 s without a change) after its cursor: filtered, sampled, scored, stored, and the cursor advanced, in one transaction. Off with the flag; a trace received before the scorer was created is not scored |
| `register.ts` | the drain's `scorers_sweep` step, after `trace_summary_refresh`; one `feature.scorers.swept` event per sweep that did work |
