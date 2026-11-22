CREATE TABLE "trace_turn_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"turn_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" text NOT NULL,
	"event_type" text NOT NULL,
	"trace_event_id" uuid NOT NULL,
	"end_trace_event_id" uuid,
	"declared" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"end_occurred_at" timestamp with time zone,
	"end_received_at" timestamp with time zone,
	"gap_ms" integer,
	"search_ordinal" integer,
	"search_type" text,
	"query_hash" text,
	"top_k" integer,
	"hit_count" integer,
	"hit_ids" text[],
	"hit_scores" real[],
	"target_type" text,
	"target_id" text,
	"invocation_id" text,
	"outcome" text,
	"took_ms" integer,
	"offered_by_ordinal" integer,
	"offered_search_ordinal" integer,
	"offered_rank" integer,
	"first_search_rank" integer
);
--> statement-breakpoint
CREATE TABLE "trace_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_id" text,
	"session_id" text NOT NULL,
	"turn_key" text NOT NULL,
	"turn_source" text NOT NULL,
	"lane" text NOT NULL,
	"end_user_key" text,
	"status" text DEFAULT 'open' NOT NULL,
	"ended_by" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"last_received_at" timestamp with time zone NOT NULL,
	"search_count" integer DEFAULT 0 NOT NULL,
	"invoke_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"distinct_tools" integer DEFAULT 0 NOT NULL,
	"re_search_count" integer DEFAULT 0 NOT NULL,
	"hits_total" integer DEFAULT 0 NOT NULL,
	"abandoned" boolean,
	"detour" boolean DEFAULT false NOT NULL,
	"first_try" boolean,
	"clock_suspect" boolean DEFAULT false NOT NULL,
	"workflow_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trace_turn_steps" ADD CONSTRAINT "trace_turn_steps_turn_id_trace_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."trace_turns"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trace_turn_steps" ADD CONSTRAINT "trace_turn_steps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trace_turns" ADD CONSTRAINT "trace_turns_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "trace_turn_steps_turn_ordinal_idx" ON "trace_turn_steps" USING btree ("turn_id","ordinal");
--> statement-breakpoint
CREATE INDEX "trace_turn_steps_project_target_idx" ON "trace_turn_steps" USING btree ("project_id","target_type","target_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "trace_turns_project_session_key_idx" ON "trace_turns" USING btree ("project_id","session_id","turn_key");
--> statement-breakpoint
CREATE INDEX "trace_turns_project_workflow_idx" ON "trace_turns" USING btree ("project_id","workflow_id","ended_at") WHERE "trace_turns"."workflow_id" is not null;
--> statement-breakpoint
CREATE INDEX "trace_turns_project_session_status_idx" ON "trace_turns" USING btree ("project_id","session_id","status");
--> statement-breakpoint
CREATE INDEX "trace_turns_open_received_idx" ON "trace_turns" USING btree ("project_id","last_received_at") WHERE "trace_turns"."status" = 'open';
--> statement-breakpoint
CREATE INDEX "trace_turns_closed_ended_idx" ON "trace_turns" USING btree ("project_id","ended_at","id") WHERE "trace_turns"."status" = 'closed';
