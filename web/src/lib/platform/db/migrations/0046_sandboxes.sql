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
ALTER TABLE "sandbox_versions" ADD CONSTRAINT "sandbox_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_versions" ADD CONSTRAINT "sandbox_versions_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandbox_versions_project_created_idx" ON "sandbox_versions" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "sandbox_versions_sandbox_created_idx" ON "sandbox_versions" USING btree ("sandbox_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sandboxes_project_name_idx" ON "sandboxes" USING btree ("project_id","name");