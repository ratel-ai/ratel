-- Traces filters by agent and MCP server (RC-790): the per-trace rollup keeps the agents and the
-- MCP servers of its spans (otel_spans.agent_key and mcp_server, migration 0039), so the Sessions
-- and Turns filters and their facet values never scan otel_spans.
-- IF NOT EXISTS: a database migrated by ratel-cloud already has these (its 0107), so this is a no-op there.
-- ADD COLUMN with a constant default is metadata-only. The migration runs in a transaction, so its
-- CREATE INDEX cannot be CONCURRENTLY and would block the summary sweep's upserts while the GIN
-- index builds. Before the deploy, run these on production, outside a transaction (psql autocommit):
--   ALTER TABLE "otel_trace_summaries" ADD COLUMN IF NOT EXISTS "agents" text[] DEFAULT '{}'::text[] NOT NULL;
--   ALTER TABLE "otel_trace_summaries" ADD COLUMN IF NOT EXISTS "mcp_servers" text[] DEFAULT '{}'::text[] NOT NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "otel_trace_summaries_agents_idx" ON "otel_trace_summaries" USING gin ("agents");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "otel_trace_summaries_mcp_servers_idx" ON "otel_trace_summaries" USING gin ("mcp_servers");
-- The CREATE INDEX IF NOT EXISTS below are then no-ops. If a CONCURRENTLY build fails it leaves an
-- INVALID index: DROP INDEX CONCURRENTLY it and rerun.
ALTER TABLE "otel_trace_summaries" ADD COLUMN IF NOT EXISTS "agents" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "otel_trace_summaries" ADD COLUMN IF NOT EXISTS "mcp_servers" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "otel_trace_summaries_agents_idx" ON "otel_trace_summaries" USING gin ("agents");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "otel_trace_summaries_mcp_servers_idx" ON "otel_trace_summaries" USING gin ("mcp_servers");
-- The sweep fills both for every trace it touches after the deploy. Older rows keep the defaults
-- until the one-off backfills run, in this order:
--   pnpm --filter @ratel/platform backfill:entity-dimensions --apply   (otel_spans, migration 0039; a dry run without --apply)
--   pnpm --filter @ratel/platform traces:backfill-filters              (these arrays, from otel_spans)
