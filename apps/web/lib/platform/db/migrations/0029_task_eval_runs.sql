CREATE TABLE "task_eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"fix_id" text NOT NULL,
	"task_id" text NOT NULL,
	"kind" text DEFAULT 'simulation' NOT NULL,
	"shipment_id" uuid,
	"scorer_version" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"results" jsonb,
	"breakdown" jsonb,
	"methods" jsonb,
	"spend" jsonb,
	"judge" jsonb,
	"change" jsonb,
	"verdict" text,
	"error" text,
	"case_count" integer DEFAULT 0 NOT NULL,
	"fix_case_count" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "task_eval_runs_kind_check" CHECK ("task_eval_runs"."kind" in ('simulation', 'post_ship')),
	CONSTRAINT "task_eval_runs_status_check" CHECK ("task_eval_runs"."status" in ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "task_eval_runs_counts_check" CHECK ("task_eval_runs"."case_count" >= 0 and "task_eval_runs"."fix_case_count" >= 0),
	CONSTRAINT "task_eval_runs_version_check" CHECK ("task_eval_runs"."scorer_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "task_eval_runs" ADD CONSTRAINT "task_eval_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_eval_runs" ADD CONSTRAINT "task_eval_runs_shipment_id_fix_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."fix_shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_eval_runs_task_created_idx" ON "task_eval_runs" USING btree ("project_id","task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_eval_runs_fix_created_idx" ON "task_eval_runs" USING btree ("project_id","fix_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_eval_runs_live_idx" ON "task_eval_runs" USING btree ("project_id","fix_id","task_id","kind") WHERE "task_eval_runs"."status" in ('queued', 'running');