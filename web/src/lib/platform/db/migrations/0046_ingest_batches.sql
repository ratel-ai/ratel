-- RTL-314: accepted ingest batches waiting for a worker. A new, empty table that no build before it
-- reads or writes: no lock on a hot table, nothing to backfill, and the old revision keeps serving.
CREATE TABLE "ingest_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"signal" text NOT NULL,
	"content_type" text NOT NULL,
	"content_encoding" text,
	"body" "bytea" NOT NULL,
	"body_bytes" integer NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"result" jsonb,
	CONSTRAINT "ingest_batches_signal_check" CHECK ("ingest_batches"."signal" in ('traces', 'logs', 'events')),
	CONSTRAINT "ingest_batches_status_check" CHECK ("ingest_batches"."status" in ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "ingest_batches" ADD CONSTRAINT "ingest_batches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingest_batches_queued_idx" ON "ingest_batches" USING btree ("project_id","received_at") WHERE "ingest_batches"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "ingest_batches_running_idx" ON "ingest_batches" USING btree ("project_id","started_at") WHERE "ingest_batches"."status" = 'running';--> statement-breakpoint
CREATE INDEX "ingest_batches_finished_idx" ON "ingest_batches" USING btree ("status","finished_at") WHERE "ingest_batches"."status" in ('done', 'failed');