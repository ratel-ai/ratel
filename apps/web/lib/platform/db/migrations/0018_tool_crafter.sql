CREATE TABLE "tool_craft_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source_tool_ids" text[] NOT NULL,
	"source_definitions" jsonb NOT NULL,
	"crafted" jsonb NOT NULL,
	"hidden_tool_ids" text[] DEFAULT '{}' NOT NULL,
	"rationale" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"expected_effect" text DEFAULT '' NOT NULL,
	"migration_notes" text DEFAULT '' NOT NULL,
	"evidence" jsonb NOT NULL,
	"backtest" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_craft_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"explorer_run_id" uuid,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposals_created" integer DEFAULT 0 NOT NULL,
	"declined_reason" text,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_craft_proposals" ADD CONSTRAINT "tool_craft_proposals_run_id_tool_craft_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."tool_craft_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tool_craft_proposals" ADD CONSTRAINT "tool_craft_proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tool_craft_runs" ADD CONSTRAINT "tool_craft_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tool_craft_runs" ADD CONSTRAINT "tool_craft_runs_explorer_run_id_tool_explorer_runs_id_fk" FOREIGN KEY ("explorer_run_id") REFERENCES "public"."tool_explorer_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "tool_craft_proposals_project_status_idx" ON "tool_craft_proposals" USING btree ("project_id","status");
--> statement-breakpoint
CREATE INDEX "tool_craft_proposals_run_idx" ON "tool_craft_proposals" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "tool_craft_runs_project_created_idx" ON "tool_craft_runs" USING btree ("project_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "tool_craft_runs_project_live_idx" ON "tool_craft_runs" USING btree ("project_id") WHERE "tool_craft_runs"."status" in ('queued', 'running');
