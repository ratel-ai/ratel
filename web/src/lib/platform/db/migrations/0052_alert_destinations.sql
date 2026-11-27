CREATE TABLE "alert_destinations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sealed_url" text NOT NULL,
	"last_four" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_rule_destinations" (
	"rule_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	CONSTRAINT "alert_rule_destinations_rule_id_destination_id_pk" PRIMARY KEY("rule_id","destination_id")
);
--> statement-breakpoint
ALTER TABLE "alert_destinations" ADD CONSTRAINT "alert_destinations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rule_destinations" ADD CONSTRAINT "alert_rule_destinations_rule_id_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rule_destinations" ADD CONSTRAINT "alert_rule_destinations_destination_id_alert_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."alert_destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_destinations_project_idx" ON "alert_destinations" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "alert_rule_destinations_destination_idx" ON "alert_rule_destinations" USING btree ("destination_id");