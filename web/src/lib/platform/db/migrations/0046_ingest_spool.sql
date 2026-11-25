-- RC-1257: the spool of INGEST_QUEUE=postgres (ADR-0009). A new, empty table that no build before it
-- reads or writes: no lock on a hot table (the foreign key locks projects for a moment, with no rows to
-- check), nothing to backfill.
CREATE TABLE "ingest_spool" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ingest_spool_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"message_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"frame" "bytea" NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deliveries" integer DEFAULT 0 NOT NULL,
	"outages" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_token" uuid,
	"claimed_until" timestamp with time zone,
	"reason" text,
	"first_failed_at" timestamp with time zone,
	"last_failed_at" timestamp with time zone,
	"dead_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ingest_spool" ADD CONSTRAINT "ingest_spool_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingest_spool_queued_idx" ON "ingest_spool" USING btree ("project_id","seq") WHERE "ingest_spool"."dead_at" is null;--> statement-breakpoint
CREATE INDEX "ingest_spool_claimed_idx" ON "ingest_spool" USING btree ("project_id") WHERE "ingest_spool"."claimed_until" is not null;--> statement-breakpoint
CREATE INDEX "ingest_spool_dead_idx" ON "ingest_spool" USING btree ("dead_at","seq") WHERE "ingest_spool"."dead_at" is not null;--> statement-breakpoint
CREATE INDEX "ingest_spool_dead_project_idx" ON "ingest_spool" USING btree ("project_id","dead_at") WHERE "ingest_spool"."dead_at" is not null;