CREATE TABLE "intent_cluster_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"trace_event_id" uuid NOT NULL,
	"ask_index" integer DEFAULT 0 NOT NULL,
	"cluster_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"session_id" text,
	"turn_id" text,
	"trace_id" text,
	"source_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intent_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"level" integer DEFAULT 0 NOT NULL,
	"parent_id" uuid,
	"graph_id" text,
	"label" text DEFAULT '' NOT NULL,
	"terms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"members" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"served_members" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"children" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"support" integer DEFAULT 0 NOT NULL,
	"asks" integer DEFAULT 0 NOT NULL,
	"edges" jsonb DEFAULT '{"tools":{},"skills":{}}'::jsonb NOT NULL,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_ts" bigint,
	"last_ts" bigint,
	"query_intent_id" uuid,
	"llm_label" text,
	"llm_label_hash" text,
	"llm_action" text,
	"llm_object" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intent_engine_state" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"clustered_through" timestamp with time zone,
	"next_graph_n" integer DEFAULT 0 NOT NULL,
	"seeded_at" timestamp with time zone,
	"named_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "intent_cluster_assignments" ADD CONSTRAINT "intent_cluster_assignments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "intent_cluster_assignments" ADD CONSTRAINT "intent_cluster_assignments_trace_event_id_trace_events_id_fk" FOREIGN KEY ("trace_event_id") REFERENCES "public"."trace_events"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "intent_clusters" ADD CONSTRAINT "intent_clusters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "intent_clusters" ADD CONSTRAINT "intent_clusters_query_intent_id_query_intents_id_fk" FOREIGN KEY ("query_intent_id") REFERENCES "public"."query_intents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "intent_engine_state" ADD CONSTRAINT "intent_engine_state_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "intent_cluster_assignments_event_idx" ON "intent_cluster_assignments" USING btree ("trace_event_id","ask_index");
--> statement-breakpoint
CREATE INDEX "intent_cluster_assignments_cluster_idx" ON "intent_cluster_assignments" USING btree ("project_id","cluster_id");
--> statement-breakpoint
CREATE INDEX "intent_cluster_assignments_trace_idx" ON "intent_cluster_assignments" USING btree ("project_id","trace_id") WHERE "intent_cluster_assignments"."trace_id" is not null;
--> statement-breakpoint
CREATE INDEX "intent_cluster_assignments_turn_idx" ON "intent_cluster_assignments" USING btree ("project_id","session_id","turn_id") WHERE "intent_cluster_assignments"."turn_id" is not null;
--> statement-breakpoint
CREATE INDEX "intent_clusters_project_level_last_idx" ON "intent_clusters" USING btree ("project_id","level","last_ts" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "intent_clusters_project_parent_idx" ON "intent_clusters" USING btree ("project_id","parent_id");
--> statement-breakpoint
CREATE INDEX "intent_clusters_query_intent_idx" ON "intent_clusters" USING btree ("query_intent_id");
