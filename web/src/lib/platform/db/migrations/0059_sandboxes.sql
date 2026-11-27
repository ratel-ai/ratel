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
CREATE TABLE "sandbox_secrets" (
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sealed_value" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_secrets_project_id_name_pk" PRIMARY KEY("project_id","name")
);
--> statement-breakpoint
CREATE TABLE "sandbox_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"sandbox_id" uuid NOT NULL,
	"manifest" jsonb NOT NULL,
	"git_commit" text NOT NULL,
	"git_dirty" boolean NOT NULL,
	"bundle_sha256" text NOT NULL,
	"bundle_bytes" bigint NOT NULL,
	"api_key_id" uuid,
	"status" text DEFAULT 'uploading' NOT NULL,
	"reason" text,
	"image_ref" text,
	"build_log" text,
	"build_started_at" timestamp with time zone,
	"build_heartbeat_at" timestamp with time zone,
	"build_finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sandbox_runs" ADD CONSTRAINT "sandbox_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_runs" ADD CONSTRAINT "sandbox_runs_version_id_sandbox_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."sandbox_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_secrets" ADD CONSTRAINT "sandbox_secrets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_versions" ADD CONSTRAINT "sandbox_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_versions" ADD CONSTRAINT "sandbox_versions_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_runs_token_hash_idx" ON "sandbox_runs" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sandbox_runs_project_created_idx" ON "sandbox_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "sandbox_runs_version_created_idx" ON "sandbox_runs" USING btree ("version_id","created_at");--> statement-breakpoint
CREATE INDEX "sandbox_runs_open_idx" ON "sandbox_runs" USING btree ("created_at") WHERE "sandbox_runs"."status" in ('queued', 'running') or ("sandbox_runs"."instance_ref" is not null and ("sandbox_runs"."instance_stopped_at" is null or "sandbox_runs"."usage_recorded_at" is null));--> statement-breakpoint
CREATE INDEX "sandbox_versions_project_created_idx" ON "sandbox_versions" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "sandbox_versions_sandbox_created_idx" ON "sandbox_versions" USING btree ("sandbox_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sandboxes_project_name_idx" ON "sandboxes" USING btree ("project_id","name");