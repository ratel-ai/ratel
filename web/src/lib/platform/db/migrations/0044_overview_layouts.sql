-- RTL-229: how one person arranged the Overview of one project. A new, empty table: no lock on a hot
-- table, nothing to backfill.
CREATE TABLE "overview_layouts" (
	"project_id" uuid NOT NULL,
	"person_id" text NOT NULL,
	"layout" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "overview_layouts_project_id_person_id_pk" PRIMARY KEY("project_id","person_id")
);
--> statement-breakpoint
ALTER TABLE "overview_layouts" ADD CONSTRAINT "overview_layouts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;