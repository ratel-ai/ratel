CREATE TABLE "trace_self_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"step_ordinal" integer,
	"tool_id" text,
	"tool_outcome" text,
	"recovered" boolean,
	"workflow_id" text,
	"phrase_category" text,
	"phrase" text,
	"source_event_id" uuid,
	"match_start" integer,
	"match_end" integer,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trace_signal_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"window_days" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"ledger_through" timestamp with time zone,
	"turns_scanned" integer DEFAULT 0 NOT NULL,
	"signals_open" integer DEFAULT 0 NOT NULL,
	"signals_new" integer DEFAULT 0 NOT NULL,
	"signals_resolved" integer DEFAULT 0 NOT NULL,
	"turn_source_mix" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"corpus_fingerprint" text,
	"summary" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trace_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"subject" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lane" text,
	"tier" text DEFAULT 'deterministic' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"severity" double precision NOT NULL,
	"impact" double precision NOT NULL,
	"n" integer NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"classifier" jsonb,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_run_id" uuid,
	"missed_runs" integer DEFAULT 0 NOT NULL,
	"resolved_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	"muted_until" timestamp with time zone,
	"proposal_kind" text,
	"proposal_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trace_workflow_insights" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"model" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trace_workflow_labels" (
	"project_id" uuid NOT NULL,
	"workflow_id" text NOT NULL,
	"input_hash" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"label_source" text DEFAULT 'llm' NOT NULL,
	"icon" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trace_workflow_labels_project_id_workflow_id_pk" PRIMARY KEY("project_id","workflow_id")
);
--> statement-breakpoint
CREATE TABLE "trace_workflow_verdicts" (
	"project_id" uuid NOT NULL,
	"prompt_hash" text NOT NULL,
	"options_hash" text NOT NULL,
	"verdict" text NOT NULL,
	"workflow_id" text,
	"confidence" double precision,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trace_workflow_verdicts_project_id_prompt_hash_options_hash_pk" PRIMARY KEY("project_id","prompt_hash","options_hash")
);
--> statement-breakpoint
ALTER TABLE "trace_self_corrections" ADD CONSTRAINT "trace_self_corrections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trace_self_corrections" ADD CONSTRAINT "trace_self_corrections_turn_id_trace_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."trace_turns"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trace_signal_runs" ADD CONSTRAINT "trace_signal_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trace_signals" ADD CONSTRAINT "trace_signals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trace_signals" ADD CONSTRAINT "trace_signals_last_run_id_trace_signal_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."trace_signal_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trace_workflow_insights" ADD CONSTRAINT "trace_workflow_insights_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trace_workflow_labels" ADD CONSTRAINT "trace_workflow_labels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trace_workflow_verdicts" ADD CONSTRAINT "trace_workflow_verdicts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "trace_self_corrections_project_time_idx" ON "trace_self_corrections" USING btree ("project_id","occurred_at");
--> statement-breakpoint
CREATE INDEX "trace_self_corrections_turn_idx" ON "trace_self_corrections" USING btree ("turn_id");
--> statement-breakpoint
CREATE INDEX "trace_signal_runs_project_created_idx" ON "trace_signal_runs" USING btree ("project_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "trace_signal_runs_project_live_idx" ON "trace_signal_runs" USING btree ("project_id") WHERE "trace_signal_runs"."status" in ('queued', 'running');
--> statement-breakpoint
CREATE UNIQUE INDEX "trace_signals_project_kind_subject_idx" ON "trace_signals" USING btree ("project_id","kind","subject_key");
--> statement-breakpoint
CREATE INDEX "trace_signals_project_status_idx" ON "trace_signals" USING btree ("project_id","status");
