CREATE TABLE "eval_baselines" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"experiment_id" uuid NOT NULL,
	"pinned_by" text NOT NULL,
	"pinned_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_baselines" ADD CONSTRAINT "eval_baselines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_baselines" ADD CONSTRAINT "eval_baselines_experiment_id_eval_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."eval_experiments"("id") ON DELETE cascade ON UPDATE no action;