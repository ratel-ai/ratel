CREATE TABLE "catalog_fingerprints" (
	"project_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"entry_count" integer NOT NULL,
	"searchable_chars" integer NOT NULL,
	"overridden_count" integer NOT NULL,
	"distinct_count" integer NOT NULL,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_fingerprints_project_id_fingerprint_pk" PRIMARY KEY("project_id","fingerprint")
);
--> statement-breakpoint
CREATE TABLE "quality_snapshots" (
	"project_id" uuid NOT NULL,
	"experiment_name" text NOT NULL,
	"arm" text NOT NULL,
	"tier" text NOT NULL,
	"day" timestamp with time zone NOT NULL,
	"n" integer NOT NULL,
	"contained" integer NOT NULL,
	"credit_sum" double precision NOT NULL,
	"reciprocal_sum" double precision NOT NULL,
	"rank_histogram" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fingerprint" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quality_snapshots_project_id_experiment_name_arm_tier_day_pk" PRIMARY KEY("project_id","experiment_name","arm","tier","day")
);
--> statement-breakpoint
ALTER TABLE "catalog_fingerprints" ADD CONSTRAINT "catalog_fingerprints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quality_snapshots" ADD CONSTRAINT "quality_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "catalog_fingerprints_project_last_seen_idx" ON "catalog_fingerprints" USING btree ("project_id","last_seen_at");
--> statement-breakpoint
CREATE INDEX "quality_snapshots_project_day_idx" ON "quality_snapshots" USING btree ("project_id","day");
