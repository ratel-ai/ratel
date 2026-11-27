CREATE TABLE "sandbox_instances" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"instance_ref" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL
);
