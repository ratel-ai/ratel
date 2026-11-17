-- Trace filters (RC-505): the per-trace rollup keeps the models and tools each
-- trace used, and its representative's service and environment, so the
-- Sessions and Turns filters and their facet values never scan otel_spans.
-- ADD COLUMN with a constant default is metadata-only. The migration runs in a
-- transaction, so its CREATE INDEX cannot be CONCURRENTLY and would block the
-- summary sweep's upserts while the GIN index builds. Before the deploy, run
-- these on production, outside a transaction (psql autocommit):
--   ALTER TABLE "otel_trace_summaries" ADD COLUMN IF NOT EXISTS "models" text[] DEFAULT '{}'::text[] NOT NULL;
--   ALTER TABLE "otel_trace_summaries" ADD COLUMN IF NOT EXISTS "tools" text[] DEFAULT '{}'::text[] NOT NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "otel_trace_summaries_models_idx" ON "otel_trace_summaries" USING gin ("models");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "otel_trace_summaries_tools_idx" ON "otel_trace_summaries" USING gin ("tools");
-- The CREATE INDEX IF NOT EXISTS below are then no-ops. If a CONCURRENTLY
-- build fails it leaves an INVALID index: DROP INDEX CONCURRENTLY it and rerun.
ALTER TABLE "otel_trace_summaries" ADD COLUMN IF NOT EXISTS "models" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "otel_trace_summaries" ADD COLUMN IF NOT EXISTS "tools" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "otel_trace_summaries" ADD COLUMN IF NOT EXISTS "service_name" text;--> statement-breakpoint
ALTER TABLE "otel_trace_summaries" ADD COLUMN IF NOT EXISTS "environment" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "otel_trace_summaries_models_idx" ON "otel_trace_summaries" USING gin ("models");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "otel_trace_summaries_tools_idx" ON "otel_trace_summaries" USING gin ("tools");
-- Existing rows keep the defaults until the one-off backfill fills them:
-- `pnpm --filter @ratel/platform traces:backfill-filters` (README). It does not
-- rewind the sweep cursor, so new summaries are never delayed.
