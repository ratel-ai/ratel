CREATE TABLE "eval_case_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"input" jsonb,
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
ALTER TABLE "eval_case_versions" ADD CONSTRAINT "eval_case_versions_case_id_eval_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."eval_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "eval_case_versions_case_number_idx" ON "eval_case_versions" USING btree ("case_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_case_versions_one_draft_idx" ON "eval_case_versions" USING btree ("case_id") WHERE "eval_case_versions"."state" = 'draft';--> statement-breakpoint
CREATE INDEX "eval_cases_project_created_idx" ON "eval_cases" USING btree ("project_id","created_at");