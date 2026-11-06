CREATE TABLE "session_replay_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"turn_id" uuid NOT NULL,
	"step" integer NOT NULL,
	"variant_kind" text NOT NULL,
	"variant_ref" text,
	"variant_key" text NOT NULL,
	"method" text NOT NULL,
	"k" integer NOT NULL,
	"model" text,
	"recorded_tool" text,
	"before_tool" text,
	"after_tool" text,
	"distribution" jsonb,
	"tokens" jsonb,
	"spend" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error_code" text,
	"requested_by" text NOT NULL,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "session_replay_runs_status_check" CHECK ("session_replay_runs"."status" in ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "session_replay_runs_method_check" CHECK ("session_replay_runs"."method" in ('replay', 'rerank')),
	CONSTRAINT "session_replay_runs_k_check" CHECK ("session_replay_runs"."k" between 1 and 10)
);
--> statement-breakpoint
CREATE TABLE "session_replay_settings" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"read_content" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_replay_runs" ADD CONSTRAINT "session_replay_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_replay_settings" ADD CONSTRAINT "session_replay_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_replay_runs_live_idx" ON "session_replay_runs" USING btree ("project_id","turn_id","step","variant_key") WHERE "session_replay_runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "session_replay_runs_project_created_idx" ON "session_replay_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "session_replay_runs_created_idx" ON "session_replay_runs" USING btree ("created_at");