-- ADR-0009 §13: the last failure of each feature's model calls, for the console's Models settings.
-- A new, empty table: no lock on a hot table, nothing to backfill. Deployment-wide, one row per feature.
CREATE TABLE "model_failures" (
	"feature" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"message" text NOT NULL,
	"status" integer,
	"failures" integer DEFAULT 1 NOT NULL,
	"failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ok_at" timestamp with time zone
);
