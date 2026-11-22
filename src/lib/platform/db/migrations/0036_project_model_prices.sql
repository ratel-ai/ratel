CREATE TABLE "project_model_prices" (
	"project_id" uuid NOT NULL,
	"model" text NOT NULL,
	"input_usd_per_mtok" numeric(12, 6) NOT NULL,
	"output_usd_per_mtok" numeric(12, 6) NOT NULL,
	"cached_input_usd_per_mtok" numeric(12, 6),
	"cache_write_usd_per_mtok" numeric(12, 6),
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_model_prices_project_id_model_pk" PRIMARY KEY("project_id","model")
);
--> statement-breakpoint
ALTER TABLE "project_model_prices" ADD CONSTRAINT "project_model_prices_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;