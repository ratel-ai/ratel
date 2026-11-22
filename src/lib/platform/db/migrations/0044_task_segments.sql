-- RC-1073 (RP-121): task segments. One row per contiguous task within a session, bounded by inclusive
-- step ordinals; the signal run writes them with FF_TYPED_STEPS on. A new, empty table: no lock on a
-- hot table, nothing to backfill.
-- IF NOT EXISTS, with the foreign keys inline, and OR REPLACE for the trigger: a database migrated by
-- ratel-cloud already has this table and trigger (its 0111), so this is a no-op there.
CREATE TABLE IF NOT EXISTS "task_segments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"start_turn_id" uuid NOT NULL,
	"start_ordinal" integer NOT NULL,
	"end_turn_id" uuid NOT NULL,
	"end_ordinal" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"turn_ids" uuid[] NOT NULL,
	"piece_count" integer NOT NULL,
	CONSTRAINT "task_segments_piece_count_check" CHECK ("task_segments"."piece_count" > 0),
	CONSTRAINT "task_segments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "task_segments_start_turn_id_trace_turns_id_fk" FOREIGN KEY ("start_turn_id") REFERENCES "public"."trace_turns"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "task_segments_end_turn_id_trace_turns_id_fk" FOREIGN KEY ("end_turn_id") REFERENCES "public"."trace_turns"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_segments_project_workflow_ended_idx" ON "task_segments" USING btree ("project_id","workflow_id","ended_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_segments_project_session_idx" ON "task_segments" USING btree ("project_id","session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_segments_turn_ids_idx" ON "task_segments" USING gin ("turn_ids");--> statement-breakpoint
-- Interior turns must remove their segment too, including during retention cleanup.
CREATE OR REPLACE FUNCTION delete_turn_task_segments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM task_segments WHERE project_id = OLD.project_id AND turn_ids @> ARRAY[OLD.id];
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER trace_turns_delete_task_segments BEFORE DELETE ON trace_turns
FOR EACH ROW EXECUTE FUNCTION delete_turn_task_segments();
