-- The old per-task scoring goes with the customMonitoring flag. A person's stored per-task scorers and
-- their daily series are removed and are not converted: the scorers of a project replace them
-- (trace_scorers, migration 0048). Nothing runs a score_tasks job any more, so a waiting one goes too.
DELETE FROM "jobs" WHERE "kind" = 'score_tasks' AND "status" = 'queued';--> statement-breakpoint
DROP TABLE "task_scorers" CASCADE;--> statement-breakpoint
DROP TABLE "task_scores_daily" CASCADE;
