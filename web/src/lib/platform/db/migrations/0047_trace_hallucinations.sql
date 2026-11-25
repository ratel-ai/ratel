CREATE TABLE "trace_hallucinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"step_ordinal" integer NOT NULL,
	"kind" text NOT NULL,
	"tool_id" text NOT NULL,
	"requested_tool_id" text,
	"evidence" text NOT NULL,
	"repeats" integer DEFAULT 1 NOT NULL,
	"worked" boolean DEFAULT false NOT NULL,
	"rule_version" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trace_hallucinations" ADD CONSTRAINT "trace_hallucinations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_hallucinations" ADD CONSTRAINT "trace_hallucinations_turn_id_trace_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."trace_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trace_hallucinations_project_time_idx" ON "trace_hallucinations" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "trace_hallucinations_turn_idx" ON "trace_hallucinations" USING btree ("turn_id");