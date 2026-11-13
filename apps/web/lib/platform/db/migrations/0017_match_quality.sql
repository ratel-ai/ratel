CREATE TABLE "match_quality_eval_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"selection_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"query" text,
	"target_entry_id" text NOT NULL,
	"target_kind" text DEFAULT 'tool' NOT NULL,
	"target_source" text NOT NULL,
	"arms" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_quality_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"query_key" text NOT NULL,
	"query" text NOT NULL,
	"entry_id" text NOT NULL,
	"source" text NOT NULL,
	"confident" boolean DEFAULT true NOT NULL,
	"confidence" double precision,
	"runner_up" text,
	"catalog_fingerprint" text,
	"model" text,
	"selection_id" text,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_quality_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"entry_id" text NOT NULL,
	"entry_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"current_searchable" text NOT NULL,
	"current_source" text NOT NULL,
	"proposed_searchable" text NOT NULL,
	"rationale" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"preview" jsonb NOT NULL,
	"backtest" jsonb,
	"applied_at" timestamp with time zone,
	"applied_by" text,
	"reverted_at" timestamp with time zone,
	"previous_override" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_quality_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"experiment_name" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"window_days" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"selections_evaluated" integer DEFAULT 0 NOT NULL,
	"revealed_n" integer DEFAULT 0 NOT NULL,
	"reference_n" integer DEFAULT 0 NOT NULL,
	"judged_n" integer DEFAULT 0 NOT NULL,
	"queries_captured" integer DEFAULT 0 NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"attribution_mode" text DEFAULT 'none' NOT NULL,
	"invoked_tool_key" text,
	"revealed_source" text DEFAULT 'none' NOT NULL,
	"baseline_arm" text,
	"serving_arm" text,
	"tuned_arm" text,
	"follow_through" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_stages" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scores" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"corpus_fingerprint" text,
	"model" text,
	"mocked" boolean DEFAULT false NOT NULL,
	"diagnosis" text,
	"diagnosis_points" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"declined_reason" text,
	"judge" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scorer" text DEFAULT 'none' NOT NULL,
	"backtest" jsonb,
	"refinement_rounds" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match_quality_eval_items" ADD CONSTRAINT "match_quality_eval_items_run_id_match_quality_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."match_quality_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "match_quality_eval_items" ADD CONSTRAINT "match_quality_eval_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "match_quality_labels" ADD CONSTRAINT "match_quality_labels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "match_quality_proposals" ADD CONSTRAINT "match_quality_proposals_run_id_match_quality_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."match_quality_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "match_quality_proposals" ADD CONSTRAINT "match_quality_proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "match_quality_runs" ADD CONSTRAINT "match_quality_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "match_quality_eval_items_run_idx" ON "match_quality_eval_items" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "match_quality_eval_items_project_occurred_idx" ON "match_quality_eval_items" USING btree ("project_id","occurred_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "match_quality_labels_project_query_idx" ON "match_quality_labels" USING btree ("project_id","query_key");
--> statement-breakpoint
CREATE INDEX "match_quality_labels_project_entry_idx" ON "match_quality_labels" USING btree ("project_id","entry_id");
--> statement-breakpoint
CREATE INDEX "match_quality_proposals_run_idx" ON "match_quality_proposals" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "match_quality_proposals_project_status_idx" ON "match_quality_proposals" USING btree ("project_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "match_quality_proposals_pending_entry_idx" ON "match_quality_proposals" USING btree ("project_id","entry_id") WHERE "match_quality_proposals"."status" = 'pending';
--> statement-breakpoint
CREATE INDEX "match_quality_runs_project_created_idx" ON "match_quality_runs" USING btree ("project_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "match_quality_runs_project_live_idx" ON "match_quality_runs" USING btree ("project_id") WHERE "match_quality_runs"."status" in ('queued', 'running');
