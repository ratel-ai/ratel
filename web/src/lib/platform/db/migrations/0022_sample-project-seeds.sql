CREATE TABLE "sample_project_seeds" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"seeded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid
);
