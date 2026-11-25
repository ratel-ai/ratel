-- RTL-259: the last changes of one person's Overview layout. A new, empty table that no build before it
-- reads or writes: no lock on a hot table, nothing to backfill.
CREATE TABLE "overview_layout_changes" (
	"project_id" uuid NOT NULL,
	"person_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"client" text,
	"summary" text NOT NULL,
	"undoes" integer,
	"before" jsonb,
	"layout" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "overview_layout_changes_project_id_person_id_seq_pk" PRIMARY KEY("project_id","person_id","seq")
);
--> statement-breakpoint
ALTER TABLE "overview_layout_changes" ADD CONSTRAINT "overview_layout_changes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;