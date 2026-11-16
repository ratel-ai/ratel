CREATE TABLE "tool_count_backfill_backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"action" text NOT NULL,
	"event_row" jsonb NOT NULL,
	"metric_row" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"restored_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tool_count_backfill_backups" ADD CONSTRAINT "tool_count_backfill_backups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_count_backfill_backups_run_event_idx" ON "tool_count_backfill_backups" USING btree ("run_id","event_id");