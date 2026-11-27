CREATE TABLE "eval_case_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"input" jsonb NOT NULL,
	"earlier_turns" jsonb NOT NULL,
	"tool_fixtures" jsonb NOT NULL,
	"expected_output" text,
	"scorers" jsonb NOT NULL,
	"source_turn_id" uuid,
	"source_output" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"sandbox_version_id" uuid NOT NULL,
	"sandbox_name" text NOT NULL,
	"git_commit" text NOT NULL,
	"git_dirty" boolean NOT NULL,
	"params" jsonb NOT NULL,
	"trials_per_case" integer NOT NULL,
	"case_versions" jsonb NOT NULL,
	"scorer_snapshots" jsonb NOT NULL,
	"started_by" text NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "eval_judge_spend" (
	"organization_id" uuid NOT NULL,
	"day" date NOT NULL,
	"usd" double precision NOT NULL,
	CONSTRAINT "eval_judge_spend_organization_id_day_pk" PRIMARY KEY("organization_id","day")
);
--> statement-breakpoint
CREATE TABLE "eval_trials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experiment_id" uuid NOT NULL,
	"case_version_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"index" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"claimed_at" timestamp with time zone,
	"result" text,
	"reason" text,
	"output" jsonb,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scorers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_usd" double precision,
	"duration_ms" double precision,
	"trace_id" text,
	"sandbox_run_id" uuid
);
--> statement-breakpoint
ALTER TABLE "eval_case_versions" ADD CONSTRAINT "eval_case_versions_case_id_eval_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."eval_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_experiments" ADD CONSTRAINT "eval_experiments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_trials" ADD CONSTRAINT "eval_trials_experiment_id_eval_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."eval_experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "eval_case_versions_case_number_idx" ON "eval_case_versions" USING btree ("case_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_case_versions_one_draft_idx" ON "eval_case_versions" USING btree ("case_id") WHERE "eval_case_versions"."state" = 'draft';--> statement-breakpoint
CREATE INDEX "eval_cases_project_created_idx" ON "eval_cases" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "eval_experiments_project_created_idx" ON "eval_experiments" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "eval_experiments_running_idx" ON "eval_experiments" USING btree ("created_at") WHERE "eval_experiments"."state" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "eval_trials_experiment_position_idx" ON "eval_trials" USING btree ("experiment_id","position");--> statement-breakpoint
CREATE INDEX "eval_trials_open_idx" ON "eval_trials" USING btree ("experiment_id") WHERE "eval_trials"."state" <> 'done';