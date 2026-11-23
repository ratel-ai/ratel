CREATE TABLE "fix_experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"fix_id" text NOT NULL,
	"insight_id" uuid,
	"name" text NOT NULL,
	"baseline_arm" text DEFAULT 'baseline' NOT NULL,
	"candidate_arm" text DEFAULT 'fix' NOT NULL,
	"traffic_percent" integer DEFAULT 50 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fix_shipment_tasks" (
	"shipment_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	CONSTRAINT "fix_shipment_tasks_shipment_id_task_id_pk" PRIMARY KEY("shipment_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "fix_shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"fix_id" text NOT NULL,
	"insight_id" uuid,
	"experiment_id" uuid,
	"version" text NOT NULL,
	"notes" text,
	"shipped_by" text NOT NULL,
	"live_marked_by" text,
	"shipped_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fix_experiments" ADD CONSTRAINT "fix_experiments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_shipment_tasks" ADD CONSTRAINT "fix_shipment_tasks_shipment_id_fix_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."fix_shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_shipments" ADD CONSTRAINT "fix_shipments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_shipments" ADD CONSTRAINT "fix_shipments_experiment_id_fix_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."fix_experiments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fix_experiments_project_name_idx" ON "fix_experiments" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "fix_experiments_project_fix_idx" ON "fix_experiments" USING btree ("project_id","fix_id");--> statement-breakpoint
CREATE INDEX "fix_shipments_project_fix_idx" ON "fix_shipments" USING btree ("project_id","fix_id");--> statement-breakpoint
CREATE INDEX "fix_shipments_project_shipped_idx" ON "fix_shipments" USING btree ("project_id","shipped_at");