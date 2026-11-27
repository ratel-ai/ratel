CREATE TABLE "eval_datasets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_pinned_baselines" (
	"eval_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"experiment_id" uuid NOT NULL,
	"pinned_by" text NOT NULL,
	"pinned_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_run_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experiment_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"input" jsonb NOT NULL,
	"earlier_turns" jsonb NOT NULL,
	"tool_fixtures" jsonb NOT NULL,
	"expected_output" text,
	"source_turn_id" uuid,
	"source_output" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_cases" DROP CONSTRAINT "eval_cases_eval_id_eval_definitions_id_fk";
--> statement-breakpoint
ALTER TABLE "eval_cases" ALTER COLUMN "eval_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "dataset_id" uuid;--> statement-breakpoint
ALTER TABLE "eval_definition_versions" ADD COLUMN "dataset_id" uuid;--> statement-breakpoint
ALTER TABLE "eval_definition_versions" ADD COLUMN "sandbox_version_id" uuid;--> statement-breakpoint
ALTER TABLE "eval_definition_versions" ADD COLUMN "matrix" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_experiments" ADD COLUMN "eval_id" uuid;--> statement-breakpoint
ALTER TABLE "eval_experiments" ADD COLUMN "dataset" jsonb;--> statement-breakpoint
ALTER TABLE "eval_experiments" ADD COLUMN "variants" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_experiments" ADD COLUMN "changes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_trials" ADD COLUMN "variant" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_datasets" ADD CONSTRAINT "eval_datasets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_pinned_baselines" ADD CONSTRAINT "eval_pinned_baselines_eval_id_eval_definitions_id_fk" FOREIGN KEY ("eval_id") REFERENCES "public"."eval_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_pinned_baselines" ADD CONSTRAINT "eval_pinned_baselines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_pinned_baselines" ADD CONSTRAINT "eval_pinned_baselines_experiment_id_eval_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."eval_experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run_rows" ADD CONSTRAINT "eval_run_rows_experiment_id_eval_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."eval_experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "eval_datasets_project_name_idx" ON "eval_datasets" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "eval_pinned_baselines_project_idx" ON "eval_pinned_baselines" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_run_rows_experiment_position_idx" ON "eval_run_rows" USING btree ("experiment_id","position");--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_dataset_id_eval_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."eval_datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_eval_id_eval_definitions_id_fk" FOREIGN KEY ("eval_id") REFERENCES "public"."eval_definitions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_cases_dataset_idx" ON "eval_cases" USING btree ("dataset_id");--> statement-breakpoint
-- Decision `datasets-first-class`: each eval gets one fixed dataset with its rows. The dataset has
-- the name of the eval (eval names are unique in a project, and there was no dataset before), and
-- each version of the eval refers to it. The rows keep their ids and their versions, so a run that
-- froze them still reads them. The scorers of each eval stay in its versions as its own scorers:
-- the library shows them as "from this eval", and no scorer moves to the project scorers.
CREATE TEMPORARY TABLE "eval_dataset_of" AS
SELECT "id" AS "eval_id", gen_random_uuid() AS "dataset_id", "project_id", "name", "created_by", "created_at"
FROM "eval_definitions";--> statement-breakpoint
INSERT INTO "eval_datasets" ("id", "project_id", "name", "kind", "settings", "created_by", "created_at", "updated_at")
SELECT "dataset_id", "project_id", "name", 'fixed', '{}'::jsonb, "created_by", "created_at", "created_at" FROM "eval_dataset_of";--> statement-breakpoint
UPDATE "eval_definition_versions" v SET "dataset_id" = d."dataset_id"
FROM "eval_dataset_of" d WHERE d."eval_id" = v."eval_id";--> statement-breakpoint
UPDATE "eval_cases" c SET "dataset_id" = d."dataset_id"
FROM "eval_dataset_of" d WHERE d."eval_id" = c."eval_id";--> statement-breakpoint
DROP TABLE "eval_dataset_of";--> statement-breakpoint
ALTER TABLE "eval_cases" ALTER COLUMN "dataset_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "eval_experiments_eval_created_idx" ON "eval_experiments" USING btree ("project_id","eval_id","created_at");