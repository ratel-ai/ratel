CREATE TABLE "trace_scorer_tasks" (
	"scorer_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trace_scorer_tasks_scorer_id_task_id_pk" PRIMARY KEY("scorer_id","task_id")
);
--> statement-breakpoint
ALTER TABLE "trace_scorers" ADD COLUMN "scope" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "trace_scorer_tasks" ADD CONSTRAINT "trace_scorer_tasks_scorer_id_trace_scorers_id_fk" FOREIGN KEY ("scorer_id") REFERENCES "public"."trace_scorers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_scorer_tasks" ADD CONSTRAINT "trace_scorer_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trace_scorer_tasks_project_task_idx" ON "trace_scorer_tasks" USING btree ("project_id","task_id");--> statement-breakpoint
ALTER TABLE "trace_scorers" ADD CONSTRAINT "trace_scorers_scope_check" CHECK ("trace_scorers"."scope" in ('all', 'tasks'));--> statement-breakpoint
INSERT INTO "trace_scorer_tasks" ("scorer_id", "task_id", "project_id") SELECT "id", "filter"->>'taskId', "project_id" FROM "trace_scorers" WHERE "filter"->>'taskId' IS NOT NULL;--> statement-breakpoint
UPDATE "trace_scorers" SET "scope" = 'tasks', "filter" = "filter" - 'taskId' WHERE "filter"->>'taskId' IS NOT NULL;
