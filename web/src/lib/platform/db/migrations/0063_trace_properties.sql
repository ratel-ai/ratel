-- RTL-395 (ADR-0012): trace properties. `trace_property_keys` holds the key names ingest saw per
-- project and their state (detected or indexed); `otel_spans.properties` and
-- `otel_trace_summaries.properties` hold the values of the indexed ones, with one shared GIN index
-- for every project. Both columns change the catalog only: the spans column is nullable with no
-- default, and the summaries column has a constant default, so no row is rewritten. The GIN index
-- builds over rows that are all '{}', but the build still scans the table one time under the lock
-- the migration transaction holds. To avoid the block on a large database, run these on
-- production before the deploy, outside a transaction (psql autocommit):
--   ALTER TABLE "otel_spans" ADD COLUMN IF NOT EXISTS "properties" jsonb;
--   ALTER TABLE "otel_trace_summaries" ADD COLUMN IF NOT EXISTS "properties" jsonb DEFAULT '{}'::jsonb NOT NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "otel_trace_summaries_properties_idx" ON "otel_trace_summaries" USING gin ("properties" jsonb_path_ops);
-- The statements below are then no-ops. If a CONCURRENTLY build fails it leaves an INVALID index:
-- DROP INDEX CONCURRENTLY it and run it again.
CREATE TABLE "trace_property_keys" (
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"state" text NOT NULL,
	"source" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_count" bigint DEFAULT 0 NOT NULL,
	"indexed_at" timestamp with time zone,
	CONSTRAINT "trace_property_keys_project_id_name_pk" PRIMARY KEY("project_id","name"),
	CONSTRAINT "trace_property_keys_state_check" CHECK ("trace_property_keys"."state" in ('detected', 'indexed')),
	CONSTRAINT "trace_property_keys_source_check" CHECK ("trace_property_keys"."source" in ('standard', 'user'))
);
--> statement-breakpoint
ALTER TABLE "otel_spans" ADD COLUMN IF NOT EXISTS "properties" jsonb;--> statement-breakpoint
ALTER TABLE "otel_trace_summaries" ADD COLUMN IF NOT EXISTS "properties" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "trace_property_keys" ADD CONSTRAINT "trace_property_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "otel_trace_summaries_properties_idx" ON "otel_trace_summaries" USING gin ("properties" jsonb_path_ops);