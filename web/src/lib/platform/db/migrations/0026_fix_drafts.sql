CREATE TABLE "fix_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"fix_id" text NOT NULL,
	"change" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"origin" text DEFAULT 'drafted' NOT NULL,
	"model" text,
	"spend" jsonb,
	"status" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fix_drafts_origin_check" CHECK ("fix_drafts"."origin" in ('drafted', 'user')),
	CONSTRAINT "fix_drafts_status_check" CHECK ("fix_drafts"."status" in ('drafting', 'ready', 'budget_refused', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "fix_drafts" ADD CONSTRAINT "fix_drafts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fix_drafts_project_fix_created_idx" ON "fix_drafts" USING btree ("project_id","fix_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fix_drafts_drafting_idx" ON "fix_drafts" USING btree ("project_id","fix_id") WHERE "fix_drafts"."status" = 'drafting';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_draft_fix_pending_idx" ON "jobs" USING btree ("project_id",("payload"->>'fixId')) WHERE "jobs"."kind" = 'draft_fix' and "jobs"."status" in ('queued', 'running');