-- Each eval version gets the dataset of its eval, before the eval loses the column.
ALTER TABLE "eval_definition_versions" ADD COLUMN "dataset_id" uuid;--> statement-breakpoint
UPDATE "eval_definition_versions" AS v SET "dataset_id" = d."dataset_id" FROM "eval_definitions" AS d WHERE d."id" = v."eval_id";--> statement-breakpoint
ALTER TABLE "eval_definition_versions" ALTER COLUMN "dataset_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_definition_versions" ADD COLUMN "sandbox_version_id" uuid;--> statement-breakpoint
ALTER TABLE "eval_definition_versions" ADD COLUMN "matrix" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_definition_versions" ADD CONSTRAINT "eval_definition_versions_dataset_id_eval_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."eval_datasets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_definition_versions_dataset_idx" ON "eval_definition_versions" USING btree ("dataset_id");--> statement-breakpoint
ALTER TABLE "eval_definitions" DROP CONSTRAINT "eval_definitions_dataset_id_eval_datasets_id_fk";--> statement-breakpoint
DROP INDEX "eval_definitions_dataset_idx";--> statement-breakpoint
ALTER TABLE "eval_definitions" DROP COLUMN "dataset_id";--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "run_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_experiments" ADD COLUMN "eval_id" uuid;--> statement-breakpoint
ALTER TABLE "eval_experiments" ADD COLUMN "dataset_id" uuid;--> statement-breakpoint
ALTER TABLE "eval_experiments" ADD COLUMN "variants" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_experiments" ADD COLUMN "changes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_trials" ADD COLUMN "variant" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- A baseline for each eval. The pin of a project stays, with no eval, for the suite runs from before.
ALTER TABLE "eval_baselines" DROP CONSTRAINT "eval_baselines_pkey";--> statement-breakpoint
ALTER TABLE "eval_baselines" ADD COLUMN "eval_id" uuid;--> statement-breakpoint
ALTER TABLE "eval_baselines" ADD CONSTRAINT "eval_baselines_eval_id_eval_definitions_id_fk" FOREIGN KEY ("eval_id") REFERENCES "public"."eval_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_baselines" ADD CONSTRAINT "eval_baselines_project_eval_key" UNIQUE NULLS NOT DISTINCT("project_id","eval_id");
