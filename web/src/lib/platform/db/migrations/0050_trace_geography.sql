CREATE TABLE "project_geo_attributes" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"country" text NOT NULL,
	"region" text NOT NULL,
	"latitude" text NOT NULL,
	"longitude" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "otel_trace_summaries" ADD COLUMN "geo_country" text;--> statement-breakpoint
ALTER TABLE "otel_trace_summaries" ADD COLUMN "geo_region" text;--> statement-breakpoint
ALTER TABLE "project_geo_attributes" ADD CONSTRAINT "project_geo_attributes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;