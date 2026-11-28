CREATE TABLE "eval_datasets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_cases" ALTER COLUMN "eval_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "dataset_id" uuid;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "resolved_turn_id" uuid;--> statement-breakpoint
ALTER TABLE "eval_definitions" ADD COLUMN "dataset_id" uuid;--> statement-breakpoint
-- Each existing eval gets one fixed dataset with its rows. The dataset has the id and the name of the eval.
INSERT INTO "eval_datasets" ("id", "project_id", "name", "kind", "settings", "created_by", "created_at", "updated_at")
SELECT "id", "project_id", "name", 'fixed', '{}'::jsonb, "created_by", "created_at", "created_at" FROM "eval_definitions";--> statement-breakpoint
UPDATE "eval_definitions" SET "dataset_id" = "id";--> statement-breakpoint
UPDATE "eval_cases" SET "dataset_id" = "eval_id";--> statement-breakpoint
ALTER TABLE "eval_definitions" ALTER COLUMN "dataset_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_cases" ALTER COLUMN "dataset_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_datasets" ADD CONSTRAINT "eval_datasets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "eval_datasets_project_name_idx" ON "eval_datasets" USING btree ("project_id","name");--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_dataset_id_eval_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."eval_datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_definitions" ADD CONSTRAINT "eval_definitions_dataset_id_eval_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."eval_datasets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_cases_dataset_idx" ON "eval_cases" USING btree ("dataset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_cases_dataset_turn_idx" ON "eval_cases" USING btree ("dataset_id","resolved_turn_id") WHERE "eval_cases"."resolved_turn_id" is not null;--> statement-breakpoint
CREATE INDEX "eval_definitions_dataset_idx" ON "eval_definitions" USING btree ("dataset_id");