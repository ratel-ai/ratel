CREATE TABLE "tool_explorer_edges" (
	"run_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"a" text NOT NULL,
	"b" text NOT NULL,
	"n" integer NOT NULL,
	"n_a" integer NOT NULL,
	"p" double precision NOT NULL,
	"p_low" double precision NOT NULL,
	"p_high" double precision NOT NULL,
	"lift" double precision NOT NULL,
	"reverse_n" integer DEFAULT 0 NOT NULL,
	"example_sessions" text[] DEFAULT '{}' NOT NULL,
	"timed_pairs" integer,
	"between_ms_total" bigint,
	"between_ms_median" integer,
	"searches_between" integer,
	CONSTRAINT "tool_explorer_edges_run_id_scope_kind_subject_a_b_pk" PRIMARY KEY("run_id","scope","kind","subject","a","b")
);
--> statement-breakpoint
CREATE TABLE "tool_explorer_intent_tools" (
	"run_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"intent_id" uuid NOT NULL,
	"intent_units" integer NOT NULL,
	"tool_id" text NOT NULL,
	"n" integer NOT NULL,
	"share" double precision NOT NULL,
	"share_low" double precision NOT NULL,
	CONSTRAINT "tool_explorer_intent_tools_run_id_scope_intent_id_tool_id_pk" PRIMARY KEY("run_id","scope","intent_id","tool_id")
);
--> statement-breakpoint
CREATE TABLE "tool_explorer_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"window_days" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"signal_run_id" uuid,
	"turns_scanned" integer DEFAULT 0 NOT NULL,
	"sessions_scanned" integer DEFAULT 0 NOT NULL,
	"turns_with_intents" integer DEFAULT 0 NOT NULL,
	"summary" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_explorer_sets" (
	"run_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"subject" text NOT NULL,
	"key" text NOT NULL,
	"items" text[] NOT NULL,
	"size" integer NOT NULL,
	"support" integer NOT NULL,
	"share" double precision NOT NULL,
	"jaccard" double precision,
	"jaccard_low" double precision,
	"p_ab" double precision,
	"p_ba" double precision,
	"workflow_id" text,
	"example_sessions" text[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "tool_explorer_sets_run_id_scope_subject_key_pk" PRIMARY KEY("run_id","scope","subject","key")
);
--> statement-breakpoint
ALTER TABLE "tool_explorer_edges" ADD CONSTRAINT "tool_explorer_edges_run_id_tool_explorer_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."tool_explorer_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tool_explorer_edges" ADD CONSTRAINT "tool_explorer_edges_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tool_explorer_intent_tools" ADD CONSTRAINT "tool_explorer_intent_tools_run_id_tool_explorer_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."tool_explorer_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tool_explorer_intent_tools" ADD CONSTRAINT "tool_explorer_intent_tools_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tool_explorer_runs" ADD CONSTRAINT "tool_explorer_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tool_explorer_runs" ADD CONSTRAINT "tool_explorer_runs_signal_run_id_trace_signal_runs_id_fk" FOREIGN KEY ("signal_run_id") REFERENCES "public"."trace_signal_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tool_explorer_sets" ADD CONSTRAINT "tool_explorer_sets_run_id_tool_explorer_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."tool_explorer_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tool_explorer_sets" ADD CONSTRAINT "tool_explorer_sets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "tool_explorer_edges_run_a_idx" ON "tool_explorer_edges" USING btree ("run_id","scope","kind","a","n");
--> statement-breakpoint
CREATE INDEX "tool_explorer_intent_tools_run_intent_idx" ON "tool_explorer_intent_tools" USING btree ("run_id","scope","intent_id","n");
--> statement-breakpoint
CREATE INDEX "tool_explorer_runs_project_created_idx" ON "tool_explorer_runs" USING btree ("project_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "tool_explorer_runs_project_live_idx" ON "tool_explorer_runs" USING btree ("project_id") WHERE "tool_explorer_runs"."status" in ('queued', 'running');
--> statement-breakpoint
CREATE INDEX "tool_explorer_sets_run_support_idx" ON "tool_explorer_sets" USING btree ("run_id","scope","subject","size","support");
