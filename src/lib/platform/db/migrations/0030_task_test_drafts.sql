CREATE TABLE "task_test_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"turn_id" uuid NOT NULL,
	"spend" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_test_drafts" ADD CONSTRAINT "task_test_drafts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_test_drafts_project_created_idx" ON "task_test_drafts" USING btree ("project_id","created_at");