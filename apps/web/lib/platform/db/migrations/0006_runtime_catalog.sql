CREATE TABLE "runtime_catalog_entries" (
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"entry_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_schema" jsonb,
	"output_schema" jsonb,
	"searchable_description" text NOT NULL,
	"searchable_description_overridden" boolean NOT NULL,
	"use_cloud_definitions" boolean DEFAULT false NOT NULL,
	"provenance" text DEFAULT 'events' NOT NULL,
	"searchable_description_override" text,
	"content_hash" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_catalog_entries_project_id_kind_entry_id_pk" PRIMARY KEY("project_id","kind","entry_id")
);
--> statement-breakpoint
ALTER TABLE "runtime_catalog_entries" ADD CONSTRAINT "runtime_catalog_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "runtime_catalog_entries_project_kind_name_idx" ON "runtime_catalog_entries" USING btree ("project_id","kind","name");
