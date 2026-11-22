CREATE TABLE "trace_topic_insights" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"model" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trace_topics" (
	"project_id" uuid NOT NULL,
	"topic_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"label_source" text DEFAULT 'llm' NOT NULL,
	"model" text,
	"input_hash" text NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trace_topics_project_id_topic_id_pk" PRIMARY KEY("project_id","topic_id")
);
--> statement-breakpoint
CREATE TABLE "trace_turn_topics" (
	"turn_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"topic_id" text,
	"verdict" text NOT NULL,
	"ask_source" text,
	"ask_hash" text,
	"sentiment" text,
	"started_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trace_topic_insights" ADD CONSTRAINT "trace_topic_insights_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trace_topics" ADD CONSTRAINT "trace_topics_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trace_turn_topics" ADD CONSTRAINT "trace_turn_topics_turn_id_trace_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."trace_turns"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trace_turn_topics" ADD CONSTRAINT "trace_turn_topics_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "trace_turn_topics_project_topic_idx" ON "trace_turn_topics" USING btree ("project_id","topic_id","started_at");
