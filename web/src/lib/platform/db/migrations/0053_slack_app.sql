CREATE TABLE "slack_apps" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"sealed_secret" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_connections" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text NOT NULL,
	"sealed_token" text NOT NULL,
	"lost_at" timestamp with time zone,
	"connected_by" text NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_destinations" ALTER COLUMN "sealed_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_destinations" ALTER COLUMN "last_four" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_destinations" ADD COLUMN "kind" text DEFAULT 'webhook' NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_destinations" ADD COLUMN "team_id" text;--> statement-breakpoint
ALTER TABLE "alert_destinations" ADD COLUMN "channel_id" text;--> statement-breakpoint
ALTER TABLE "alert_destinations" ADD COLUMN "access_error" text;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_destinations_channel_idx" ON "alert_destinations" USING btree ("project_id","team_id","channel_id");--> statement-breakpoint
ALTER TABLE "alert_destinations" ADD CONSTRAINT "alert_destinations_kind_check" CHECK (("alert_destinations"."kind" = 'webhook' and "alert_destinations"."sealed_url" is not null and "alert_destinations"."last_four" is not null) or ("alert_destinations"."kind" = 'slack_channel' and "alert_destinations"."team_id" is not null and "alert_destinations"."channel_id" is not null));