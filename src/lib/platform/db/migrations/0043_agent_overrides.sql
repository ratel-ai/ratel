-- RC-776: agent overrides. One row per (project_id, agent_key): a display name, hidden, or merged
-- into another agent key. The Agents reads apply them at read time; otel_spans is not changed.
-- A new, empty table: no lock on a hot table, nothing to backfill.
-- IF NOT EXISTS, with the foreign key inline as upstream wrote it: a database migrated by
-- ratel-cloud already has this table (its 0108), so this is a no-op there.
CREATE TABLE IF NOT EXISTS "agent_overrides" (
	"project_id" uuid NOT NULL,
	"agent_key" text NOT NULL,
	"display_name" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"merged_into" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_overrides_project_id_agent_key_pk" PRIMARY KEY("project_id","agent_key"),
	CONSTRAINT "agent_overrides_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action
);
