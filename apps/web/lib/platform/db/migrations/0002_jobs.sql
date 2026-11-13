CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "jobs_project_status_idx" ON "jobs" USING btree ("project_id","status");
--> statement-breakpoint
CREATE INDEX "jobs_status_created_idx" ON "jobs" USING btree ("status","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_build_trace_turns_queued_idx" ON "jobs" USING btree ("project_id","kind") WHERE "jobs"."status" = 'queued' and "jobs"."kind" = 'build_trace_turns';
--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_compute_trace_signals_queued_idx" ON "jobs" USING btree ("project_id","kind") WHERE "jobs"."status" = 'queued' and "jobs"."kind" = 'compute_trace_signals';
--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_label_workflows_queued_idx" ON "jobs" USING btree ("project_id","kind") WHERE "jobs"."status" = 'queued' and "jobs"."kind" = 'label_workflows';
--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_explore_tool_usage_queued_idx" ON "jobs" USING btree ("project_id","kind") WHERE "jobs"."status" = 'queued' and "jobs"."kind" = 'explore_tool_usage';
--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_craft_tools_queued_idx" ON "jobs" USING btree ("project_id","kind") WHERE "jobs"."status" = 'queued' and "jobs"."kind" = 'craft_tools';
--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_fold_intent_graph_queued_idx" ON "jobs" USING btree ("project_id","kind") WHERE "jobs"."status" = 'queued' and "jobs"."kind" = 'fold_intent_graph';
--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_cluster_intents_queued_idx" ON "jobs" USING btree ("project_id","kind") WHERE "jobs"."status" = 'queued' and "jobs"."kind" = 'cluster_intents';
--> statement-breakpoint
CREATE INDEX "jobs_fold_intent_graph_finished_idx" ON "jobs" USING btree ("project_id","finished_at") WHERE "jobs"."kind" = 'fold_intent_graph';
--> statement-breakpoint
CREATE INDEX "jobs_cluster_intents_finished_idx" ON "jobs" USING btree ("project_id","finished_at") WHERE "jobs"."kind" = 'cluster_intents';
