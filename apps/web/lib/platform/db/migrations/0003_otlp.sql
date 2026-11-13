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
ALTER TABLE "event_metrics" ADD CONSTRAINT "event_metrics_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "event_metrics" ADD CONSTRAINT "event_metrics_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "otel_logs" ADD CONSTRAINT "otel_logs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "otel_spans" ADD CONSTRAINT "otel_spans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "event_metrics_project_time_idx" ON "event_metrics" USING btree ("project_id","event_time");
--> statement-breakpoint
CREATE UNIQUE INDEX "event_metrics_event_id_idx" ON "event_metrics" USING btree ("event_id");
--> statement-breakpoint
CREATE INDEX "events_project_trace_idx" ON "events" USING btree ("project_id","trace_id") WHERE "events"."trace_id" is not null;
--> statement-breakpoint
CREATE INDEX "events_project_event_time_idx" ON "events" USING btree ("project_id",coalesce("occurred_at", "received_at"));
--> statement-breakpoint
CREATE UNIQUE INDEX "events_project_dedupe_idx" ON "events" USING btree ("project_id","dedupe_hash");
--> statement-breakpoint
CREATE INDEX "otel_logs_received_at_idx" ON "otel_logs" USING btree ("received_at","id");
--> statement-breakpoint
CREATE INDEX "otel_logs_project_occurred_idx" ON "otel_logs" USING btree ("project_id","occurred_at","id");
--> statement-breakpoint
CREATE INDEX "otel_logs_project_trace_idx" ON "otel_logs" USING btree ("project_id","trace_id") WHERE "otel_logs"."trace_id" is not null;
--> statement-breakpoint
CREATE INDEX "otel_logs_project_event_idx" ON "otel_logs" USING btree ("project_id","event_id") WHERE "otel_logs"."event_id" is not null;
--> statement-breakpoint
CREATE INDEX "otel_logs_project_event_occurred_idx" ON "otel_logs" USING btree ("project_id","event_name","occurred_at");
--> statement-breakpoint
CREATE INDEX "otel_logs_project_experiment_occurred_idx" ON "otel_logs" USING btree ("project_id","experiment_name","experiment_arm","occurred_at") WHERE "otel_logs"."experiment_name" is not null;
--> statement-breakpoint
CREATE INDEX "otel_logs_project_selection_idx" ON "otel_logs" USING btree ("project_id","experiment_selection_id") WHERE "otel_logs"."experiment_selection_id" is not null;
--> statement-breakpoint
CREATE INDEX "otel_spans_received_at_idx" ON "otel_spans" USING btree ("received_at","id");
--> statement-breakpoint
CREATE INDEX "otel_spans_project_trace_idx" ON "otel_spans" USING btree ("project_id","trace_id");
--> statement-breakpoint
CREATE INDEX "otel_spans_project_event_idx" ON "otel_spans" USING btree ("project_id","event_id") WHERE "otel_spans"."event_id" is not null;
--> statement-breakpoint
CREATE INDEX "otel_spans_project_started_trace_idx" ON "otel_spans" USING btree ("project_id","started_at","trace_id");
--> statement-breakpoint
CREATE INDEX "otel_spans_project_roots_started_idx" ON "otel_spans" USING btree ("project_id","started_at") WHERE "otel_spans"."parent_span_id" is null;
--> statement-breakpoint
CREATE INDEX "otel_spans_project_experiment_started_idx" ON "otel_spans" USING btree ("project_id","experiment_name","experiment_arm","started_at") WHERE "otel_spans"."experiment_name" is not null;
--> statement-breakpoint
CREATE INDEX "otel_spans_project_trace_root_idx" ON "otel_spans" USING btree ("project_id","trace_id",("parent_span_id" is null) desc,"started_at","span_id");
