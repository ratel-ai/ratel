-- AOBS-3: whether the run's own outcome is an error: the status of the canonical representative (the root span).
-- `has_error` stays "any span reported an error". Null on a summary last written before this column: the sweep
-- fills it for every trace it touches, and `traces:backfill-filters` recomputes the older rows.
-- IF NOT EXISTS: a database migrated by ratel-cloud already has it (its 0109), so this is a no-op there.
ALTER TABLE "otel_trace_summaries" ADD COLUMN IF NOT EXISTS "root_error" boolean;
