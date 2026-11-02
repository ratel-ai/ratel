CREATE TABLE "catalog_snapshots" (
	"project_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"tool_count" integer NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_snapshots_project_id_source_id_pk" PRIMARY KEY("project_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "catalog_tool_definitions" (
	"project_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"searchable_description" text,
	"input_schema" jsonb,
	"output_schema" jsonb,
	"metadata" jsonb,
	CONSTRAINT "catalog_tool_definitions_project_id_source_id_tool_id_pk" PRIMARY KEY("project_id","source_id","tool_id")
);
--> statement-breakpoint
ALTER TABLE "catalog_snapshots" ADD CONSTRAINT "catalog_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "catalog_tool_definitions" ADD CONSTRAINT "catalog_tool_definitions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "catalog_snapshots_project_received_idx" ON "catalog_snapshots" USING btree ("project_id","received_at");
--> statement-breakpoint
CREATE INDEX "catalog_tool_definitions_project_name_idx" ON "catalog_tool_definitions" USING btree ("project_id","name");
