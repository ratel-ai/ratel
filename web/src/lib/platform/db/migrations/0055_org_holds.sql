CREATE TABLE "org_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"project_id" uuid,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_holds_one_scope" CHECK (num_nonnulls("org_holds"."organization_id", "org_holds"."project_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "org_holds" ADD CONSTRAINT "org_holds_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_holds_organization_idx" ON "org_holds" USING btree ("organization_id") WHERE "org_holds"."organization_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "org_holds_project_idx" ON "org_holds" USING btree ("project_id") WHERE "org_holds"."project_id" is not null;