CREATE TABLE "query_intent_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"query_intent_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"trace_event_id" uuid NOT NULL,
	"intent_index" integer DEFAULT 0 NOT NULL,
	"query" text NOT NULL,
	"session_id" text,
	"end_user_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "query_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"normalized_text" text NOT NULL,
	"text" text NOT NULL,
	"occurrences" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"member_text" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "query_intent_occurrences" ADD CONSTRAINT "query_intent_occurrences_query_intent_id_query_intents_id_fk" FOREIGN KEY ("query_intent_id") REFERENCES "public"."query_intents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "query_intent_occurrences" ADD CONSTRAINT "query_intent_occurrences_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "query_intent_occurrences" ADD CONSTRAINT "query_intent_occurrences_trace_event_id_trace_events_id_fk" FOREIGN KEY ("trace_event_id") REFERENCES "public"."trace_events"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "query_intents" ADD CONSTRAINT "query_intents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "query_intent_occurrences_trace_event_idx" ON "query_intent_occurrences" USING btree ("trace_event_id","intent_index");
--> statement-breakpoint
CREATE INDEX "query_intent_occurrences_query_intent_idx" ON "query_intent_occurrences" USING btree ("query_intent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "query_intents_project_normalized_idx" ON "query_intents" USING btree ("project_id","normalized_text");
--> statement-breakpoint
CREATE INDEX "query_intents_project_occurrences_idx" ON "query_intents" USING btree ("project_id","occurrences");
--> statement-breakpoint
CREATE INDEX "query_intents_project_last_seen_idx" ON "query_intents" USING btree ("project_id","last_seen_at");
