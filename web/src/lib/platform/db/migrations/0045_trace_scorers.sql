CREATE TABLE "scorer_judge_spend" (
	"project_id" uuid NOT NULL,
	"day" date NOT NULL,
	"usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	CONSTRAINT "scorer_judge_spend_project_id_day_pk" PRIMARY KEY("project_id","day")
);
--> statement-breakpoint
CREATE TABLE "trace_scorers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb NOT NULL,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sample_rate" integer DEFAULT 100 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"cursor_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cursor_trace_id" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trace_scorers_kind_check" CHECK ("trace_scorers"."kind" in ('check', 'judge')),
	CONSTRAINT "trace_scorers_sample_rate_check" CHECK ("trace_scorers"."sample_rate" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "trace_scores" (
	"scorer_id" uuid NOT NULL,
	"trace_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"value" double precision NOT NULL,
	"passed" boolean,
	"confidence" double precision,
	"trace_started_at" timestamp with time zone NOT NULL,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trace_scores_scorer_id_trace_id_pk" PRIMARY KEY("scorer_id","trace_id")
);
--> statement-breakpoint
ALTER TABLE "scorer_judge_spend" ADD CONSTRAINT "scorer_judge_spend_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_scorers" ADD CONSTRAINT "trace_scorers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_scores" ADD CONSTRAINT "trace_scores_scorer_id_trace_scorers_id_fk" FOREIGN KEY ("scorer_id") REFERENCES "public"."trace_scorers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_scores" ADD CONSTRAINT "trace_scores_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trace_scorers_project_idx" ON "trace_scorers" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "trace_scorers_enabled_idx" ON "trace_scorers" USING btree ("cursor_at") WHERE "trace_scorers"."enabled";--> statement-breakpoint
CREATE INDEX "trace_scores_project_trace_idx" ON "trace_scores" USING btree ("project_id","trace_id");--> statement-breakpoint
CREATE INDEX "trace_scores_scorer_started_idx" ON "trace_scores" USING btree ("scorer_id","trace_started_at");--> statement-breakpoint
CREATE INDEX "trace_scores_project_started_idx" ON "trace_scores" USING btree ("project_id","trace_started_at");--> statement-breakpoint
CREATE INDEX "otel_trace_summaries_project_updated_idx" ON "otel_trace_summaries" USING btree ("project_id","updated_at","trace_id");