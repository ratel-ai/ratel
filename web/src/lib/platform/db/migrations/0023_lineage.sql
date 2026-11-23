CREATE TABLE "lineage_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"kind" text NOT NULL,
	"object_id" text NOT NULL,
	"source_stage" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"source_label" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lineage_links" ADD CONSTRAINT "lineage_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lineage_links_project_object_idx" ON "lineage_links" USING btree ("project_id","kind","object_id");--> statement-breakpoint
CREATE INDEX "lineage_links_project_source_idx" ON "lineage_links" USING btree ("project_id","source_kind","source_id");--> statement-breakpoint
CREATE INDEX "lineage_links_project_stage_idx" ON "lineage_links" USING btree ("project_id","stage");