CREATE TABLE "intent_graph_runtime_status" (
	"project_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"rev" bigint,
	"graph_key" text,
	"learn" boolean DEFAULT true NOT NULL,
	"model" text,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "intent_graph_runtime_status_project_id_source_id_pk" PRIMARY KEY("project_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "tool_usage_counters" (
	"project_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"calls" bigint DEFAULT 0 NOT NULL,
	"errors" bigint DEFAULT 0 NOT NULL,
	"total_duration_ms" bigint DEFAULT 0 NOT NULL,
	"first_used_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tool_usage_counters_project_id_source_id_tool_id_pk" PRIMARY KEY("project_id","source_id","tool_id")
);
--> statement-breakpoint
CREATE TABLE "trace_event_hits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_event_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"end_user_id" text,
	"rank" integer NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"score" double precision
);
--> statement-breakpoint
CREATE TABLE "trace_event_rejects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"event_id" text,
	"type" text,
	"reason" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"source_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trace_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"type" text NOT NULL,
	"schema_version" integer,
	"session_id" text,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ingest_source" text,
	"client_event_id" text NOT NULL,
	"event_id" text,
	"source_id" text,
	"invocation_id" text,
	"trace_id" text,
	"span_id" text,
	"turn_id" text,
	"tool_id" text,
	"skill_id" text,
	"query" text,
	"origin" text,
	"took_ms" integer,
	"error_message" text,
	"top_k" integer,
	"hit_count" integer,
	"server" text,
	"search_id" text,
	"correlation_id" text,
	"catalog_version" text,
	"harness" text,
	"environment" text,
	"end_user_id" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(12, 6),
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "intent_graph_runtime_status" ADD CONSTRAINT "intent_graph_runtime_status_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tool_usage_counters" ADD CONSTRAINT "tool_usage_counters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trace_event_hits" ADD CONSTRAINT "trace_event_hits_trace_event_id_trace_events_id_fk" FOREIGN KEY ("trace_event_id") REFERENCES "public"."trace_events"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trace_event_hits" ADD CONSTRAINT "trace_event_hits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trace_event_rejects" ADD CONSTRAINT "trace_event_rejects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trace_events" ADD CONSTRAINT "trace_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "tool_usage_counters_project_calls_idx" ON "tool_usage_counters" USING btree ("project_id","calls");
--> statement-breakpoint
CREATE UNIQUE INDEX "trace_event_hits_event_rank_idx" ON "trace_event_hits" USING btree ("trace_event_id","rank");
--> statement-breakpoint
CREATE INDEX "trace_event_hits_project_target_idx" ON "trace_event_hits" USING btree ("project_id","target_type","target_id");
--> statement-breakpoint
CREATE INDEX "trace_event_rejects_project_time_idx" ON "trace_event_rejects" USING btree ("project_id","received_at");
--> statement-breakpoint
CREATE INDEX "trace_event_rejects_received_at_idx" ON "trace_event_rejects" USING btree ("received_at","id");
--> statement-breakpoint
CREATE INDEX "trace_events_project_type_time_idx" ON "trace_events" USING btree ("project_id","type",coalesce("occurred_at", "received_at"));
--> statement-breakpoint
CREATE INDEX "trace_events_project_type_skill_idx" ON "trace_events" USING btree ("project_id","type","skill_id");
--> statement-breakpoint
CREATE INDEX "trace_events_project_type_tool_idx" ON "trace_events" USING btree ("project_id","type","tool_id");
--> statement-breakpoint
CREATE INDEX "trace_events_project_source_time_idx" ON "trace_events" USING btree ("project_id","source_id","received_at") WHERE "trace_events"."source_id" is not null;
--> statement-breakpoint
CREATE INDEX "trace_events_project_trace_idx" ON "trace_events" USING btree ("project_id","trace_id","span_id") WHERE "trace_events"."trace_id" is not null;
--> statement-breakpoint
CREATE INDEX "trace_events_project_event_idx" ON "trace_events" USING btree ("project_id","event_id") WHERE "trace_events"."event_id" is not null;
--> statement-breakpoint
CREATE INDEX "trace_events_ingest_source_received_idx" ON "trace_events" USING btree ("ingest_source","received_at","id") WHERE "trace_events"."ingest_source" is not null;
--> statement-breakpoint
CREATE INDEX "trace_events_project_ingest_time_idx" ON "trace_events" USING btree ("project_id","ingest_source",coalesce("occurred_at", "received_at"));
--> statement-breakpoint
CREATE INDEX "trace_events_project_received_fold_idx" ON "trace_events" USING btree ("project_id","received_at","id") WHERE "trace_events"."type" in ('search', 'skill_search', 'invoke_start', 'skill_invoke', 'otlp_model_call', 'invoke_end', 'invoke_error');
--> statement-breakpoint
CREATE INDEX "trace_events_project_user_type_time_idx" ON "trace_events" USING btree ("project_id","end_user_id","type",coalesce("occurred_at", "received_at")) WHERE "trace_events"."end_user_id" is not null;
--> statement-breakpoint
CREATE INDEX "trace_events_project_received_turn_idx" ON "trace_events" USING btree ("project_id","received_at","id") WHERE "trace_events"."type" in ('search', 'skill_search', 'gateway_search', 'invoke_start', 'invoke_end', 'invoke_error', 'gateway_invoke', 'gateway_error', 'skill_invoke');
