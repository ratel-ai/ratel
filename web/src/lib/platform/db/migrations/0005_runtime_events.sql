CREATE TABLE "runtime_event_sources" (
	"project_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"facts_started_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_event_sources_project_id_source_id_pk" PRIMARY KEY("project_id","source_id")
);
--> statement-breakpoint
ALTER TABLE "runtime_event_sources" ADD CONSTRAINT "runtime_event_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "runtime_event_sources_project_last_seen_idx" ON "runtime_event_sources" USING btree ("project_id","last_seen_at");
