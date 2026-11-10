-- PostgreSQL auto-analyzes after threshold + scale_factor * live tuples. The
-- defaults had grown the otel_spans trigger to ~1,351 changes, enough to leave a
-- new project's 495 rows hidden behind stale project_id statistics. A zero
-- analyze scale factor makes the trigger independent of retained table size;
-- 1,000 bounds statistics drift to a small fixed shared-ingest window without
-- analyzing every batch. Vacuum remains proportional at 5% because its work is
-- driven by table-wide dead tuples rather than planner visibility for one
-- project's new rows. Logs and summaries share the same ingest/prune churn.
--
-- The same three statements as upstream's 0026_otel_autovacuum_analyze, which
-- this repository's split migrations had not carried. Upstream also runs
-- ANALYZE on the three tables once; that is left out here: a database that has
-- upstream's migration was analyzed then, and on any other the new threshold
-- triggers the first analyze by itself.
ALTER TABLE "otel_spans" SET (
	autovacuum_analyze_scale_factor = 0.0,
	autovacuum_analyze_threshold = 1000,
	autovacuum_vacuum_scale_factor = 0.05
);
--> statement-breakpoint
ALTER TABLE "otel_logs" SET (
	autovacuum_analyze_scale_factor = 0.0,
	autovacuum_analyze_threshold = 1000,
	autovacuum_vacuum_scale_factor = 0.05
);
--> statement-breakpoint
ALTER TABLE "otel_trace_summaries" SET (
	autovacuum_analyze_scale_factor = 0.0,
	autovacuum_analyze_threshold = 1000,
	autovacuum_vacuum_scale_factor = 0.05
);
