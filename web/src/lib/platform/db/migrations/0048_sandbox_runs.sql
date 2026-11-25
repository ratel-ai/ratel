CREATE TABLE "sandbox_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"run_input" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"reason" text,
	"trace_id" text,
	"token_hash" text NOT NULL,
	"instance_ref" text,
	"timeout_s" integer NOT NULL,
	"requested_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"instance_stopped_at" timestamp with time zone,
	"usage_recorded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sandbox_runs" ADD CONSTRAINT "sandbox_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_runs" ADD CONSTRAINT "sandbox_runs_version_id_sandbox_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."sandbox_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_runs_token_hash_idx" ON "sandbox_runs" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sandbox_runs_project_created_idx" ON "sandbox_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "sandbox_runs_version_created_idx" ON "sandbox_runs" USING btree ("version_id","created_at");--> statement-breakpoint
CREATE INDEX "sandbox_runs_open_idx" ON "sandbox_runs" USING btree ("created_at") WHERE "sandbox_runs"."status" in ('queued', 'running') or ("sandbox_runs"."instance_ref" is not null and ("sandbox_runs"."instance_stopped_at" is null or "sandbox_runs"."usage_recorded_at" is null));