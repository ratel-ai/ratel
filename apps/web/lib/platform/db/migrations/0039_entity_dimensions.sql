-- RC-772: entity dimensions, derived at OTLP ingest by lib/ingest/otlp/dimensions. The agent a span
-- ran under, the agent that called it, and the MCP server it provides or consumes, each with how it
-- was found (sdk | semconv | heuristic), and the MCP transport session (mcp_session_id, from the
-- span's mcp.session.id). Only otel_spans gets columns. Every column is nullable with no default, so
-- the ALTERs change the catalog only and rewrite no row. Rows stored before this stay null until
-- `pnpm --filter @ratel/platform backfill:entity-dimensions --apply` fills them (without --apply it
-- is a dry run that only counts). The backfill does not fill mcp_session_id: stored rows do not keep it.
-- IF NOT EXISTS: a database migrated by ratel-cloud already has these (its 0106), so this is a no-op there.
ALTER TABLE "otel_spans" ADD COLUMN IF NOT EXISTS "agent_key" text;--> statement-breakpoint
ALTER TABLE "otel_spans" ADD COLUMN IF NOT EXISTS "agent_source" text;--> statement-breakpoint
ALTER TABLE "otel_spans" ADD COLUMN IF NOT EXISTS "caller_agent_key" text;--> statement-breakpoint
ALTER TABLE "otel_spans" ADD COLUMN IF NOT EXISTS "mcp_server" text;--> statement-breakpoint
ALTER TABLE "otel_spans" ADD COLUMN IF NOT EXISTS "mcp_server_source" text;--> statement-breakpoint
ALTER TABLE "otel_spans" ADD COLUMN IF NOT EXISTS "mcp_role" text;--> statement-breakpoint
ALTER TABLE "otel_spans" ADD COLUMN IF NOT EXISTS "mcp_session_id" text;--> statement-breakpoint
-- Both indexes are partial: they hold only the rows whose dimension is set. The columns above are
-- null on every row stored before this migration, so here the two indexes build empty: the build
-- scans otel_spans one time and writes no entry. The backfill and new ingest then add the entries.
-- drizzle's migrate() wraps a migration in one transaction, where a plain CREATE INDEX blocks
-- writes on the hot otel_spans table for that scan. To avoid the block on a large database, run
-- these first, out of band and outside a transaction (psql autocommit):
--   the seven ALTER TABLE statements above;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "otel_spans_project_agent_key_started_idx" ON "otel_spans" USING btree ("project_id","agent_key","started_at") WHERE "agent_key" is not null;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "otel_spans_project_mcp_server_started_idx" ON "otel_spans" USING btree ("project_id","mcp_server","started_at") WHERE "mcp_server" is not null;
-- Then the IF NOT EXISTS statements here are no-ops at deploy. If a CONCURRENTLY build fails it
-- leaves an INVALID index: DROP INDEX CONCURRENTLY it and run it again.
CREATE INDEX IF NOT EXISTS "otel_spans_project_agent_key_started_idx" ON "otel_spans" USING btree ("project_id","agent_key","started_at") WHERE "otel_spans"."agent_key" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "otel_spans_project_mcp_server_started_idx" ON "otel_spans" USING btree ("project_id","mcp_server","started_at") WHERE "otel_spans"."mcp_server" is not null;
