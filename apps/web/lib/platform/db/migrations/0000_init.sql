CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"searchable_description" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"end_user_id" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tool_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"parameters" jsonb,
	"source" text DEFAULT 'sync' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "event_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"event_time" timestamp with time zone NOT NULL,
	"tokens_by_category" jsonb NOT NULL,
	"splits" jsonb NOT NULL,
	"tools_by_name" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tools_total_count" integer DEFAULT 0 NOT NULL,
	"tools_used_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(12, 6),
	"latency_ms" integer,
	"categorizer_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurred_at" timestamp with time zone,
	"provider" text,
	"model" text,
	"stream" boolean,
	"finish_reason" text,
	"latency_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cached_tokens" integer,
	"reasoning_tokens" integer,
	"cost_usd" numeric(12, 6),
	"payload" jsonb,
	"dedupe_hash" text,
	"categorizer_version" integer,
	"trace_id" text,
	"span_id" text
);
--> statement-breakpoint
CREATE TABLE "otel_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"event_name" text NOT NULL,
	"event_id" text,
	"source_id" text,
	"ingest_source" text,
	"trace_id" text,
	"span_id" text,
	"severity_number" integer DEFAULT 0 NOT NULL,
	"service_name" text,
	"scope_name" text,
	"body" jsonb,
	"experiment_name" text,
	"experiment_arm" text,
	"experiment_role" text,
	"experiment_selection_id" text,
	"experiment_attrs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attributes" jsonb NOT NULL,
	"attrs_truncated" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otel_spans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trace_id" text NOT NULL,
	"span_id" text NOT NULL,
	"event_id" text,
	"source_id" text,
	"parent_span_id" text,
	"name" text NOT NULL,
	"kind" integer NOT NULL,
	"span_class" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"duration_ms" double precision NOT NULL,
	"status_code" integer NOT NULL,
	"service_name" text,
	"scope_name" text,
	"operation_name" text,
	"provider_name" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cached_tokens" integer,
	"reasoning_tokens" integer,
	"cost_usd" numeric(12, 6),
	"search_origin" text,
	"search_target" text,
	"search_query" text,
	"search_top_k" integer,
	"search_hit_count" integer,
	"experiment_name" text,
	"experiment_arm" text,
	"experiment_role" text,
	"experiment_attrs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attributes" jsonb NOT NULL,
	"attrs_truncated" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_catalog_entries" (
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"entry_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_schema" jsonb,
	"output_schema" jsonb,
	"searchable_description" text NOT NULL,
	"searchable_description_overridden" boolean NOT NULL,
	"use_cloud_definitions" boolean DEFAULT false NOT NULL,
	"provenance" text DEFAULT 'events' NOT NULL,
	"searchable_description_override" text,
	"content_hash" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_catalog_entries_project_id_kind_entry_id_pk" PRIMARY KEY("project_id","kind","entry_id")
);
--> statement-breakpoint
CREATE TABLE "runtime_event_sources" (
	"project_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"facts_started_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_event_sources_project_id_source_id_pk" PRIMARY KEY("project_id","source_id")
);
--> statement-breakpoint
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
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
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
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"limit_overrides" jsonb,
	"demo_project_seeded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text NOT NULL,
	"username" text,
	"email" text,
	"name" text,
	"avatar_url" text,
	"current_organization_id" uuid,
	"last_project_id" uuid,
	"onboarding_tour_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"catalog_version" text,
	"catalog_version_v2" text,
	"overrides_pulled_at" timestamp with time zone,
	"intent_graph_pulled_at" timestamp with time zone,
	"query_intents_categorized_through" timestamp with time zone,
	"intent_graph_folded_through" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	"trace_turns_built_through" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_definitions" ADD CONSTRAINT "tool_definitions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_snapshots" ADD CONSTRAINT "catalog_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_tool_definitions" ADD CONSTRAINT "catalog_tool_definitions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_metrics" ADD CONSTRAINT "event_metrics_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_metrics" ADD CONSTRAINT "event_metrics_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otel_logs" ADD CONSTRAINT "otel_logs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otel_spans" ADD CONSTRAINT "otel_spans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_catalog_entries" ADD CONSTRAINT "runtime_catalog_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_event_sources" ADD CONSTRAINT "runtime_event_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intent_graph_runtime_status" ADD CONSTRAINT "intent_graph_runtime_status_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_usage_counters" ADD CONSTRAINT "tool_usage_counters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_event_hits" ADD CONSTRAINT "trace_event_hits_trace_event_id_trace_events_id_fk" FOREIGN KEY ("trace_event_id") REFERENCES "public"."trace_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_event_hits" ADD CONSTRAINT "trace_event_hits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_event_rejects" ADD CONSTRAINT "trace_event_rejects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_events" ADD CONSTRAINT "trace_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_turn_steps" ADD CONSTRAINT "trace_turn_steps_turn_id_trace_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."trace_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_turn_steps" ADD CONSTRAINT "trace_turn_steps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_turns" ADD CONSTRAINT "trace_turns_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_current_organization_id_organizations_id_fk" FOREIGN KEY ("current_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_last_project_id_projects_id_fk" FOREIGN KEY ("last_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skills_project_name_active_idx" ON "skills" USING btree ("project_id","name") WHERE "skills"."status" <> 'archived';--> statement-breakpoint
CREATE INDEX "skills_project_status_idx" ON "skills" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_definitions_project_name_idx" ON "tool_definitions" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "catalog_snapshots_project_received_idx" ON "catalog_snapshots" USING btree ("project_id","received_at");--> statement-breakpoint
CREATE INDEX "catalog_tool_definitions_project_name_idx" ON "catalog_tool_definitions" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "event_metrics_project_time_idx" ON "event_metrics" USING btree ("project_id","event_time");--> statement-breakpoint
CREATE UNIQUE INDEX "event_metrics_event_id_idx" ON "event_metrics" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "events_project_trace_idx" ON "events" USING btree ("project_id","trace_id") WHERE "events"."trace_id" is not null;--> statement-breakpoint
CREATE INDEX "events_project_event_time_idx" ON "events" USING btree ("project_id",coalesce("occurred_at", "received_at"));--> statement-breakpoint
CREATE UNIQUE INDEX "events_project_dedupe_idx" ON "events" USING btree ("project_id","dedupe_hash");--> statement-breakpoint
CREATE INDEX "otel_logs_received_at_idx" ON "otel_logs" USING btree ("received_at","id");--> statement-breakpoint
CREATE INDEX "otel_logs_project_occurred_idx" ON "otel_logs" USING btree ("project_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "otel_logs_project_trace_idx" ON "otel_logs" USING btree ("project_id","trace_id") WHERE "otel_logs"."trace_id" is not null;--> statement-breakpoint
CREATE INDEX "otel_logs_project_event_idx" ON "otel_logs" USING btree ("project_id","event_id") WHERE "otel_logs"."event_id" is not null;--> statement-breakpoint
CREATE INDEX "otel_logs_project_event_occurred_idx" ON "otel_logs" USING btree ("project_id","event_name","occurred_at");--> statement-breakpoint
CREATE INDEX "otel_logs_project_experiment_occurred_idx" ON "otel_logs" USING btree ("project_id","experiment_name","experiment_arm","occurred_at") WHERE "otel_logs"."experiment_name" is not null;--> statement-breakpoint
CREATE INDEX "otel_logs_project_selection_idx" ON "otel_logs" USING btree ("project_id","experiment_selection_id") WHERE "otel_logs"."experiment_selection_id" is not null;--> statement-breakpoint
CREATE INDEX "otel_spans_received_at_idx" ON "otel_spans" USING btree ("received_at","id");--> statement-breakpoint
CREATE INDEX "otel_spans_project_trace_idx" ON "otel_spans" USING btree ("project_id","trace_id");--> statement-breakpoint
CREATE INDEX "otel_spans_project_event_idx" ON "otel_spans" USING btree ("project_id","event_id") WHERE "otel_spans"."event_id" is not null;--> statement-breakpoint
CREATE INDEX "otel_spans_project_started_trace_idx" ON "otel_spans" USING btree ("project_id","started_at","trace_id");--> statement-breakpoint
CREATE INDEX "otel_spans_project_roots_started_idx" ON "otel_spans" USING btree ("project_id","started_at") WHERE "otel_spans"."parent_span_id" is null;--> statement-breakpoint
CREATE INDEX "otel_spans_project_experiment_started_idx" ON "otel_spans" USING btree ("project_id","experiment_name","experiment_arm","started_at") WHERE "otel_spans"."experiment_name" is not null;--> statement-breakpoint
CREATE INDEX "otel_spans_project_trace_root_idx" ON "otel_spans" USING btree ("project_id","trace_id",("parent_span_id" is null) desc,"started_at","span_id");--> statement-breakpoint
CREATE INDEX "runtime_catalog_entries_project_kind_name_idx" ON "runtime_catalog_entries" USING btree ("project_id","kind","name");--> statement-breakpoint
CREATE INDEX "runtime_event_sources_project_last_seen_idx" ON "runtime_event_sources" USING btree ("project_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "tool_usage_counters_project_calls_idx" ON "tool_usage_counters" USING btree ("project_id","calls");--> statement-breakpoint
CREATE UNIQUE INDEX "trace_event_hits_event_rank_idx" ON "trace_event_hits" USING btree ("trace_event_id","rank");--> statement-breakpoint
CREATE INDEX "trace_event_hits_project_target_idx" ON "trace_event_hits" USING btree ("project_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "trace_event_rejects_project_time_idx" ON "trace_event_rejects" USING btree ("project_id","received_at");--> statement-breakpoint
CREATE INDEX "trace_event_rejects_received_at_idx" ON "trace_event_rejects" USING btree ("received_at","id");--> statement-breakpoint
CREATE INDEX "trace_events_project_type_time_idx" ON "trace_events" USING btree ("project_id","type",coalesce("occurred_at", "received_at"));--> statement-breakpoint
CREATE INDEX "trace_events_project_type_skill_idx" ON "trace_events" USING btree ("project_id","type","skill_id");--> statement-breakpoint
CREATE INDEX "trace_events_project_type_tool_idx" ON "trace_events" USING btree ("project_id","type","tool_id");--> statement-breakpoint
CREATE INDEX "trace_events_project_source_time_idx" ON "trace_events" USING btree ("project_id","source_id","received_at") WHERE "trace_events"."source_id" is not null;--> statement-breakpoint
CREATE INDEX "trace_events_project_trace_idx" ON "trace_events" USING btree ("project_id","trace_id","span_id") WHERE "trace_events"."trace_id" is not null;--> statement-breakpoint
CREATE INDEX "trace_events_project_event_idx" ON "trace_events" USING btree ("project_id","event_id") WHERE "trace_events"."event_id" is not null;--> statement-breakpoint
CREATE INDEX "trace_events_ingest_source_received_idx" ON "trace_events" USING btree ("ingest_source","received_at","id") WHERE "trace_events"."ingest_source" is not null;--> statement-breakpoint
CREATE INDEX "trace_events_project_ingest_time_idx" ON "trace_events" USING btree ("project_id","ingest_source",coalesce("occurred_at", "received_at"));--> statement-breakpoint
CREATE INDEX "trace_events_project_received_fold_idx" ON "trace_events" USING btree ("project_id","received_at","id") WHERE "trace_events"."type" in ('search', 'skill_search', 'invoke_start', 'skill_invoke', 'otlp_model_call', 'invoke_end', 'invoke_error');--> statement-breakpoint
CREATE INDEX "trace_events_project_user_type_time_idx" ON "trace_events" USING btree ("project_id","end_user_id","type",coalesce("occurred_at", "received_at")) WHERE "trace_events"."end_user_id" is not null;--> statement-breakpoint
CREATE INDEX "trace_events_project_received_turn_idx" ON "trace_events" USING btree ("project_id","received_at","id") WHERE "trace_events"."type" in ('search', 'skill_search', 'gateway_search', 'invoke_start', 'invoke_end', 'invoke_error', 'gateway_invoke', 'gateway_error', 'skill_invoke');--> statement-breakpoint
CREATE INDEX "jobs_project_status_idx" ON "jobs" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "jobs_status_created_idx" ON "jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_build_trace_turns_queued_idx" ON "jobs" USING btree ("project_id","kind") WHERE "jobs"."status" = 'queued' and "jobs"."kind" = 'build_trace_turns';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_compute_trace_signals_queued_idx" ON "jobs" USING btree ("project_id","kind") WHERE "jobs"."status" = 'queued' and "jobs"."kind" = 'compute_trace_signals';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_label_workflows_queued_idx" ON "jobs" USING btree ("project_id","kind") WHERE "jobs"."status" = 'queued' and "jobs"."kind" = 'label_workflows';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_explore_tool_usage_queued_idx" ON "jobs" USING btree ("project_id","kind") WHERE "jobs"."status" = 'queued' and "jobs"."kind" = 'explore_tool_usage';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_craft_tools_queued_idx" ON "jobs" USING btree ("project_id","kind") WHERE "jobs"."status" = 'queued' and "jobs"."kind" = 'craft_tools';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_fold_intent_graph_queued_idx" ON "jobs" USING btree ("project_id","kind") WHERE "jobs"."status" = 'queued' and "jobs"."kind" = 'fold_intent_graph';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_cluster_intents_queued_idx" ON "jobs" USING btree ("project_id","kind") WHERE "jobs"."status" = 'queued' and "jobs"."kind" = 'cluster_intents';--> statement-breakpoint
CREATE INDEX "jobs_fold_intent_graph_finished_idx" ON "jobs" USING btree ("project_id","finished_at") WHERE "jobs"."kind" = 'fold_intent_graph';--> statement-breakpoint
CREATE INDEX "jobs_cluster_intents_finished_idx" ON "jobs" USING btree ("project_id","finished_at") WHERE "jobs"."kind" = 'cluster_intents';--> statement-breakpoint
CREATE UNIQUE INDEX "trace_turn_steps_turn_ordinal_idx" ON "trace_turn_steps" USING btree ("turn_id","ordinal");--> statement-breakpoint
CREATE INDEX "trace_turn_steps_project_target_idx" ON "trace_turn_steps" USING btree ("project_id","target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trace_turns_project_session_key_idx" ON "trace_turns" USING btree ("project_id","session_id","turn_key");--> statement-breakpoint
CREATE INDEX "trace_turns_project_workflow_idx" ON "trace_turns" USING btree ("project_id","workflow_id","ended_at") WHERE "trace_turns"."workflow_id" is not null;--> statement-breakpoint
CREATE INDEX "trace_turns_project_session_status_idx" ON "trace_turns" USING btree ("project_id","session_id","status");--> statement-breakpoint
CREATE INDEX "trace_turns_open_received_idx" ON "trace_turns" USING btree ("project_id","last_received_at") WHERE "trace_turns"."status" = 'open';--> statement-breakpoint
CREATE INDEX "trace_turns_closed_ended_idx" ON "trace_turns" USING btree ("project_id","ended_at","id") WHERE "trace_turns"."status" = 'closed';--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_org_idx" ON "memberships" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE INDEX "memberships_org_id_idx" ON "memberships" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_idx" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_project_id_idx" ON "api_keys" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_organization_slug_idx" ON "projects" USING btree ("organization_id","slug");