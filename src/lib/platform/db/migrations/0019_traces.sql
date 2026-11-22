CREATE TABLE "otel_trace_summaries" (
	"project_id" uuid NOT NULL,
	"trace_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" double precision NOT NULL,
	"has_error" boolean NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cost_usd" numeric(18, 6) NOT NULL,
	"spans_max_received_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otel_trace_summaries_project_id_trace_id_pk" PRIMARY KEY("project_id","trace_id")
);
--> statement-breakpoint
CREATE TABLE "trace_summary_cursor" (
	"id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"span_row_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "otel_trace_summaries" ADD CONSTRAINT "otel_trace_summaries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "otel_trace_summaries_project_started_idx" ON "otel_trace_summaries" USING btree ("project_id","started_at");
--> statement-breakpoint
CREATE INDEX "otel_trace_summaries_spans_max_received_idx" ON "otel_trace_summaries" USING btree ("spans_max_received_at");
