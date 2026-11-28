-- RTL-420: Ask in words. One row per ask: the project, who asked, for what (a dashboard or a
-- widget), the words, the draft the model gave, its cost in USD and what the person did with it
-- (kept, edited, discarded). The limits of Ask in words count these rows. A new, empty table.
CREATE TABLE "ask_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"surface" text NOT NULL,
	"target" text NOT NULL,
	"dashboard_id" uuid,
	"words" text NOT NULL,
	"draft" jsonb,
	"model" text NOT NULL,
	"usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ask_requests" ADD CONSTRAINT "ask_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ask_requests_project_created_idx" ON "ask_requests" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "ask_requests_actor_created_idx" ON "ask_requests" USING btree ("actor","created_at");