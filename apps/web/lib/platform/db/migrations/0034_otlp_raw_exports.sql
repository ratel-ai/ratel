-- Raw OTLP request bodies (RC-404): one gzipped row per accepted export, kept
-- within a per-project daily byte cap and pruned on received_at. New and empty,
-- so plain CREATE INDEX is safe here.
CREATE TABLE IF NOT EXISTS "otlp_raw_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signal" text NOT NULL,
	"content_type" text NOT NULL,
	"body" bytea NOT NULL,
	"raw_bytes" integer NOT NULL,
	"stored_bytes" integer NOT NULL,
	"item_count" integer NOT NULL,
	"trace_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "otlp_raw_exports_signal_check" CHECK ("otlp_raw_exports"."signal" in ('traces', 'logs'))
);
--> statement-breakpoint
ALTER TABLE "otlp_raw_exports" ADD CONSTRAINT "otlp_raw_exports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "otlp_raw_exports_project_received_idx" ON "otlp_raw_exports" USING btree ("project_id","received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "otlp_raw_exports_received_at_idx" ON "otlp_raw_exports" USING btree ("received_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "otlp_raw_exports_trace_ids_idx" ON "otlp_raw_exports" USING gin ("trace_ids");
