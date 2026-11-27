CREATE TABLE "alert_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"value" double precision,
	"operator" text NOT NULL,
	"threshold" double precision NOT NULL,
	"window_minutes" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"notice" text,
	"delivery" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"sent_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	CONSTRAINT "alert_events_notice_check" CHECK ("alert_events"."notice" in ('fire', 'recovery')),
	CONSTRAINT "alert_events_delivery_check" CHECK ("alert_events"."delivery" in ('none', 'pending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"query" jsonb NOT NULL,
	"operator" text NOT NULL,
	"threshold" double precision NOT NULL,
	"window_minutes" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"state" text DEFAULT 'no_data' NOT NULL,
	"firing" boolean DEFAULT false NOT NULL,
	"last_value" double precision,
	"state_changed_at" timestamp with time zone,
	"last_evaluated_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_rules_operator_check" CHECK ("alert_rules"."operator" in ('above', 'below')),
	CONSTRAINT "alert_rules_window_check" CHECK ("alert_rules"."window_minutes" in (5, 15, 60, 1440)),
	CONSTRAINT "alert_rules_state_check" CHECK ("alert_rules"."state" in ('ok', 'alerting', 'no_data'))
);
--> statement-breakpoint
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_rule_id_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_events_rule_at_idx" ON "alert_events" USING btree ("rule_id","at");--> statement-breakpoint
CREATE INDEX "alert_events_pending_idx" ON "alert_events" USING btree ("at") WHERE "alert_events"."delivery" = 'pending';--> statement-breakpoint
CREATE INDEX "alert_rules_project_idx" ON "alert_rules" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "alert_rules_enabled_idx" ON "alert_rules" USING btree ("last_evaluated_at") WHERE "alert_rules"."enabled";