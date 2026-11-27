CREATE TABLE "project_repositories" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'github' NOT NULL,
	"repository_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"installation_id" bigint,
	"default_branch" text NOT NULL,
	"version_branches" text[] DEFAULT '{}' NOT NULL,
	"pull_requests" boolean DEFAULT true NOT NULL,
	"config_path" text DEFAULT 'ratel.yaml' NOT NULL,
	"linked_by" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_commits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"repository_id" bigint NOT NULL,
	"sha" text NOT NULL,
	"base_sha" text,
	"branch" text NOT NULL,
	"pull_request" integer,
	"from_fork" boolean DEFAULT false NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"status" text NOT NULL,
	"reason" text,
	"sandbox_version_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_commits" ADD CONSTRAINT "repository_commits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_repositories_repository_idx" ON "project_repositories" USING btree ("provider","repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_commits_commit_idx" ON "repository_commits" USING btree ("project_id","repository_id","sha");--> statement-breakpoint
CREATE INDEX "repository_commits_project_received_idx" ON "repository_commits" USING btree ("project_id","received_at");