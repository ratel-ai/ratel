CREATE TABLE "fix_eval_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"set_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"trace_id" text,
	"origin" text NOT NULL,
	"origin_ref" text,
	"expected" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" text DEFAULT '' NOT NULL,
	"criteria" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fix_eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"set_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text NOT NULL,
	"requested_by" text,
	"job_id" uuid,
	"n_cases" integer DEFAULT 0 NOT NULL,
	"n_simulated" integer DEFAULT 0 NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"interval" jsonb,
	"verdict" text,
	"results" jsonb,
	"change" jsonb,
	"error" text,
	"replay" boolean DEFAULT false NOT NULL,
	"evidence" jsonb,
	"breakdown" jsonb,
	"methods" jsonb,
	"spend" jsonb,
	"judge" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fix_eval_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"fix_id" text NOT NULL,
	"fix_kind" text NOT NULL,
	"title" text NOT NULL,
	"change" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" jsonb,
	"target_runs" integer DEFAULT 20 NOT NULL,
	"created_by" text,
	"evidence_turn_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fix_eval_cases" ADD CONSTRAINT "fix_eval_cases_set_id_fix_eval_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."fix_eval_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_eval_cases" ADD CONSTRAINT "fix_eval_cases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_eval_runs" ADD CONSTRAINT "fix_eval_runs_set_id_fix_eval_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."fix_eval_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_eval_runs" ADD CONSTRAINT "fix_eval_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_eval_sets" ADD CONSTRAINT "fix_eval_sets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fix_eval_cases_set_turn_idx" ON "fix_eval_cases" USING btree ("set_id","turn_id");--> statement-breakpoint
CREATE INDEX "fix_eval_cases_set_position_idx" ON "fix_eval_cases" USING btree ("set_id","position");--> statement-breakpoint
CREATE INDEX "fix_eval_runs_set_created_idx" ON "fix_eval_runs" USING btree ("set_id","created_at");--> statement-breakpoint
CREATE INDEX "fix_eval_runs_project_created_idx" ON "fix_eval_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fix_eval_runs_set_live_idx" ON "fix_eval_runs" USING btree ("set_id") WHERE "fix_eval_runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "fix_eval_sets_project_fix_idx" ON "fix_eval_sets" USING btree ("project_id","fix_id");