CREATE TABLE "task_eval_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"turn_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"fix_id" text,
	"pinned" boolean DEFAULT false NOT NULL,
	"excluded_at" timestamp with time zone,
	"expected" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"criteria" text DEFAULT '' NOT NULL,
	"selection_reason" text DEFAULT '' NOT NULL,
	"test_name" text,
	"test_ask" text,
	CONSTRAINT "task_eval_cases_project_task_fix_turn_key" UNIQUE NULLS NOT DISTINCT("project_id","task_id","fix_id","turn_id"),
	CONSTRAINT "task_eval_cases_origin_check" CHECK ("task_eval_cases"."origin" in ('auto', 'issue', 'user', 'fix')),
	CONSTRAINT "task_eval_cases_fix_check" CHECK (("task_eval_cases"."origin" = 'fix') = ("task_eval_cases"."fix_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "task_eval_sets" (
	"project_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"target_runs" integer DEFAULT 20 NOT NULL,
	"scorer_version" integer NOT NULL,
	"refreshed_at" timestamp with time zone,
	CONSTRAINT "task_eval_sets_project_id_task_id_pk" PRIMARY KEY("project_id","task_id"),
	CONSTRAINT "task_eval_sets_target_check" CHECK ("task_eval_sets"."target_runs" between 1 and 200),
	CONSTRAINT "task_eval_sets_version_check" CHECK ("task_eval_sets"."scorer_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "task_scorers" (
	"project_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'default' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_scorers_project_id_task_id_kind_pk" PRIMARY KEY("project_id","task_id","kind"),
	CONSTRAINT "task_scorers_source_check" CHECK ("task_scorers"."source" in ('default', 'user')),
	CONSTRAINT "task_scorers_kind_check" CHECK ("task_scorers"."kind" in ('ends_well', 'max_self_corrections', 'max_latency_ms', 'max_cost_usd', 'expected_tool', 'max_tool_calls', 'judge_criteria')),
	CONSTRAINT "task_scorers_version_check" CHECK ("task_scorers"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "task_scores_daily" (
	"project_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"day" date NOT NULL,
	"scorer_kind" text NOT NULL,
	"scorer_version" integer NOT NULL,
	"judge_spend" jsonb,
	"n" integer NOT NULL,
	"passed" integer NOT NULL,
	CONSTRAINT "task_scores_daily_project_id_task_id_day_scorer_kind_pk" PRIMARY KEY("project_id","task_id","day","scorer_kind"),
	CONSTRAINT "task_scores_daily_kind_check" CHECK ("task_scores_daily"."scorer_kind" in ('overall', 'ends_well', 'max_self_corrections', 'max_latency_ms', 'max_cost_usd', 'expected_tool', 'max_tool_calls', 'judge_criteria')),
	CONSTRAINT "task_scores_daily_counts_check" CHECK ("task_scores_daily"."n" >= 0 and "task_scores_daily"."passed" >= 0 and "task_scores_daily"."passed" <= "task_scores_daily"."n"),
	CONSTRAINT "task_scores_daily_version_check" CHECK ("task_scores_daily"."scorer_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "task_eval_cases" ADD CONSTRAINT "task_eval_cases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_eval_cases" ADD CONSTRAINT "task_eval_cases_project_id_task_id_task_eval_sets_project_id_task_id_fk" FOREIGN KEY ("project_id","task_id") REFERENCES "public"."task_eval_sets"("project_id","task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_eval_sets" ADD CONSTRAINT "task_eval_sets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_scorers" ADD CONSTRAINT "task_scorers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_scores_daily" ADD CONSTRAINT "task_scores_daily_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;