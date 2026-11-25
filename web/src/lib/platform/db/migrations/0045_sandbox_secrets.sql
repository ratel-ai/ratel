CREATE TABLE "sandbox_secrets" (
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sealed_value" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_secrets_project_id_name_pk" PRIMARY KEY("project_id","name")
);
--> statement-breakpoint
ALTER TABLE "sandbox_secrets" ADD CONSTRAINT "sandbox_secrets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;