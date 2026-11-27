-- RTL-321: the session and the end user on otel_spans and otel_trace_summaries, so a query can
-- group spans and traces by them. Ingest stores the values trace_events gets (session_id and the
-- raw end_user_id). The summary sweep copies the first non-null span value of the trace. Every
-- column is nullable with no default, so the ALTERs change the catalog only and rewrite no row.
-- Rows stored before this stay null until
-- `pnpm --filter @ratel/platform backfill:session-user-ids --apply` fills them from trace_events
-- (without --apply it is a dry run that only counts).
-- The three indexes are partial: they hold only the rows whose value is set, so here they build
-- empty, but the build still scans each table one time. drizzle's migrate() wraps a migration in
-- one transaction, where a plain CREATE INDEX blocks writes to the table for that scan. To avoid
-- the block on a large database, run these on production before the deploy, outside a
-- transaction (psql autocommit):
--   ALTER TABLE "otel_spans" ADD COLUMN IF NOT EXISTS "session_id" text;
--   ALTER TABLE "otel_spans" ADD COLUMN IF NOT EXISTS "end_user_id" text;
--   ALTER TABLE "otel_trace_summaries" ADD COLUMN IF NOT EXISTS "session_id" text;
--   ALTER TABLE "otel_trace_summaries" ADD COLUMN IF NOT EXISTS "end_user_id" text;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "otel_spans_project_session_started_idx" ON "otel_spans" USING btree ("project_id","session_id","started_at") WHERE "otel_spans"."session_id" is not null;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "otel_trace_summaries_project_session_started_idx" ON "otel_trace_summaries" USING btree ("project_id","session_id","started_at") WHERE "otel_trace_summaries"."session_id" is not null;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "otel_trace_summaries_project_end_user_started_idx" ON "otel_trace_summaries" USING btree ("project_id","end_user_id","started_at") WHERE "otel_trace_summaries"."end_user_id" is not null;
-- The statements below are then no-ops. If a CONCURRENTLY build fails it leaves an INVALID index:
-- DROP INDEX CONCURRENTLY it and run it again.
ALTER TABLE "otel_spans" ADD COLUMN IF NOT EXISTS "session_id" text;--> statement-breakpoint
ALTER TABLE "otel_spans" ADD COLUMN IF NOT EXISTS "end_user_id" text;--> statement-breakpoint
ALTER TABLE "otel_trace_summaries" ADD COLUMN IF NOT EXISTS "session_id" text;--> statement-breakpoint
ALTER TABLE "otel_trace_summaries" ADD COLUMN IF NOT EXISTS "end_user_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "otel_spans_project_session_started_idx" ON "otel_spans" USING btree ("project_id","session_id","started_at") WHERE "otel_spans"."session_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "otel_trace_summaries_project_session_started_idx" ON "otel_trace_summaries" USING btree ("project_id","session_id","started_at") WHERE "otel_trace_summaries"."session_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "otel_trace_summaries_project_end_user_started_idx" ON "otel_trace_summaries" USING btree ("project_id","end_user_id","started_at") WHERE "otel_trace_summaries"."end_user_id" is not null;
