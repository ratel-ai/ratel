CREATE TABLE "trace_session_outcomes" (
	"project_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"outcome" text,
	"outcome_source" text,
	"friction_count" integer DEFAULT 0 NOT NULL,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"first_turn_id" uuid NOT NULL,
	"last_turn_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"open_request" boolean DEFAULT false NOT NULL,
	"unmet_searches" integer DEFAULT 0 NOT NULL,
	"catalog_listings" integer DEFAULT 0 NOT NULL,
	"rule_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trace_session_outcomes_project_id_session_id_pk" PRIMARY KEY("project_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "trace_task_outcomes" (
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"turn_ids" uuid[] NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"goal_source" text NOT NULL,
	"tier" text NOT NULL,
	"result" text NOT NULL,
	"reason" text,
	"cause" text,
	"checked" boolean DEFAULT false NOT NULL,
	"result_source" text NOT NULL,
	"answer" text,
	"answer_probability" real,
	"rule_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trace_task_outcomes_project_id_task_id_pk" PRIMARY KEY("project_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "trace_turn_outcomes" (
	"turn_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"result" text,
	"result_source" text,
	"cause" text,
	"cause_source" text,
	"followed" text,
	"failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ok_calls" integer DEFAULT 0 NOT NULL,
	"failed_calls" integer DEFAULT 0 NOT NULL,
	"errors_unread" integer DEFAULT 0 NOT NULL,
	"unmet_searches" integer DEFAULT 0 NOT NULL,
	"catalog_listings" integer DEFAULT 0 NOT NULL,
	"rule_version" integer NOT NULL,
	"satisfaction" text,
	"reaction" text,
	"claimed_done" boolean,
	"request" boolean,
	"model_version" integer,
	"reply_reaction" text,
	"reply_reaction_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trace_session_outcomes" ADD CONSTRAINT "trace_session_outcomes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_task_outcomes" ADD CONSTRAINT "trace_task_outcomes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_turn_outcomes" ADD CONSTRAINT "trace_turn_outcomes_turn_id_trace_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."trace_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_turn_outcomes" ADD CONSTRAINT "trace_turn_outcomes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trace_session_outcomes_project_ended_idx" ON "trace_session_outcomes" USING btree ("project_id","ended_at");--> statement-breakpoint
CREATE INDEX "trace_task_outcomes_project_ended_idx" ON "trace_task_outcomes" USING btree ("project_id","ended_at");--> statement-breakpoint
CREATE INDEX "trace_task_outcomes_project_session_idx" ON "trace_task_outcomes" USING btree ("project_id","session_id");--> statement-breakpoint
CREATE INDEX "trace_turn_outcomes_project_ended_idx" ON "trace_turn_outcomes" USING btree ("project_id","ended_at");--> statement-breakpoint
CREATE INDEX "trace_turn_outcomes_project_session_idx" ON "trace_turn_outcomes" USING btree ("project_id","session_id","started_at");