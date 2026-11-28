-- Decision dashboard-templates: each dashboard a template made for a project. A default is given
-- one time: the partial unique key on (project_id, template_id) makes two first reads at the same
-- time give it once, and its row stays when the dashboard is deleted, so it does not come back.
-- A pick is a kept signal of Ask in words. A new table: no rewrite.
CREATE TABLE "dashboard_template_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"template_id" text NOT NULL,
	"dashboard_id" uuid,
	"given" text NOT NULL,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dashboard_template_uses" ADD CONSTRAINT "dashboard_template_uses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_template_uses" ADD CONSTRAINT "dashboard_template_uses_dashboard_id_dashboards_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_template_uses_default_key" ON "dashboard_template_uses" USING btree ("project_id","template_id") WHERE "dashboard_template_uses"."given" = 'default';--> statement-breakpoint
CREATE INDEX "dashboard_template_uses_project_created_idx" ON "dashboard_template_uses" USING btree ("project_id","created_at");