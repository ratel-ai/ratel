CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"limit_overrides" jsonb,
	"demo_project_seeded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text NOT NULL,
	"username" text,
	"email" text,
	"name" text,
	"avatar_url" text,
	"current_organization_id" uuid,
	"last_project_id" uuid,
	"onboarding_tour_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"catalog_version" text,
	"catalog_version_v2" text,
	"overrides_pulled_at" timestamp with time zone,
	"intent_graph_pulled_at" timestamp with time zone,
	"query_intents_categorized_through" timestamp with time zone,
	"intent_graph_folded_through" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	"trace_turns_built_through" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_current_organization_id_organizations_id_fk" FOREIGN KEY ("current_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_last_project_id_projects_id_fk" FOREIGN KEY ("last_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_project_status_idx" ON "jobs" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "jobs_status_created_idx" ON "jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_build_trace_turns_queued_idx" ON "jobs" USING btree ("project_id","kind") WHERE "jobs"."status" = 'queued' and "jobs"."kind" = 'build_trace_turns';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_compute_trace_signals_queued_idx" ON "jobs" USING btree ("project_id","kind") WHERE "jobs"."status" = 'queued' and "jobs"."kind" = 'compute_trace_signals';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_label_workflows_queued_idx" ON "jobs" USING btree ("project_id","kind") WHERE "jobs"."status" = 'queued' and "jobs"."kind" = 'label_workflows';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_explore_tool_usage_queued_idx" ON "jobs" USING btree ("project_id","kind") WHERE "jobs"."status" = 'queued' and "jobs"."kind" = 'explore_tool_usage';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_craft_tools_queued_idx" ON "jobs" USING btree ("project_id","kind") WHERE "jobs"."status" = 'queued' and "jobs"."kind" = 'craft_tools';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_fold_intent_graph_queued_idx" ON "jobs" USING btree ("project_id","kind") WHERE "jobs"."status" = 'queued' and "jobs"."kind" = 'fold_intent_graph';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_cluster_intents_queued_idx" ON "jobs" USING btree ("project_id","kind") WHERE "jobs"."status" = 'queued' and "jobs"."kind" = 'cluster_intents';--> statement-breakpoint
CREATE INDEX "jobs_fold_intent_graph_finished_idx" ON "jobs" USING btree ("project_id","finished_at") WHERE "jobs"."kind" = 'fold_intent_graph';--> statement-breakpoint
CREATE INDEX "jobs_cluster_intents_finished_idx" ON "jobs" USING btree ("project_id","finished_at") WHERE "jobs"."kind" = 'cluster_intents';--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_org_idx" ON "memberships" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE INDEX "memberships_org_id_idx" ON "memberships" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_idx" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_project_id_idx" ON "api_keys" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_organization_slug_idx" ON "projects" USING btree ("organization_id","slug");