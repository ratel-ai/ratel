ALTER TABLE "sandbox_versions" ALTER COLUMN "manifest" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_versions" ALTER COLUMN "git_commit" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_versions" ALTER COLUMN "git_dirty" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_versions" ADD COLUMN "config" jsonb;--> statement-breakpoint
ALTER TABLE "sandbox_versions" ADD COLUMN "image_digest" text;--> statement-breakpoint
ALTER TABLE "sandbox_versions" ADD COLUMN "image_platform" text;--> statement-breakpoint
ALTER TABLE "sandbox_versions" ADD COLUMN "smoke" jsonb;--> statement-breakpoint
-- A version pushed before images keeps its name, its secret names and its tools as a ratel.yaml.
UPDATE "sandbox_versions" AS v SET "config" =
  jsonb_build_object('name', s."name", 'input', jsonb_build_object('example', 'null'::jsonb))
  || CASE WHEN jsonb_array_length(coalesce(v."manifest"->'secrets', '[]'::jsonb)) > 0
       THEN jsonb_build_object('secrets', v."manifest"->'secrets') ELSE '{}'::jsonb END
  || CASE WHEN jsonb_array_length(coalesce(v."manifest"->'tools', '[]'::jsonb)) > 0
       THEN jsonb_build_object('tools', (
         SELECT jsonb_object_agg(t->>'name', jsonb_build_object('mode',
           CASE WHEN (t->>'sideEffect')::boolean THEN 'simulated' ELSE 'live' END))
         FROM jsonb_array_elements(v."manifest"->'tools') AS t))
       ELSE '{}'::jsonb END
FROM "sandboxes" AS s
WHERE s."id" = v."sandbox_id" AND v."config" IS NULL;--> statement-breakpoint
-- It has no image, so it cannot run.
UPDATE "sandbox_versions"
SET "status" = 'failed', "reason" = 'This version was pushed before images. Push it again.', "image_ref" = NULL
WHERE "image_digest" IS NULL AND "status" <> 'failed';--> statement-breakpoint
ALTER TABLE "sandbox_versions" ALTER COLUMN "config" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_versions" DROP COLUMN "manifest";--> statement-breakpoint
CREATE TABLE "sandbox_vms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"vm_ref" text,
	"state" text DEFAULT 'starting' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "sandbox_runs" ADD COLUMN "response" jsonb;--> statement-breakpoint
ALTER TABLE "sandbox_runs" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "sandbox_runs" ADD COLUMN "logs" text;--> statement-breakpoint
ALTER TABLE "sandbox_runs" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "sandbox_runs" ADD COLUMN "vm_id" uuid;--> statement-breakpoint
CREATE INDEX "sandbox_vms_project_started_idx" ON "sandbox_vms" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE INDEX "sandbox_vms_live_idx" ON "sandbox_vms" USING btree ("version_id","last_used_at") WHERE "sandbox_vms"."state" <> 'deleted';--> statement-breakpoint
CREATE INDEX "sandbox_runs_vm_active_idx" ON "sandbox_runs" USING btree ("vm_id") WHERE "sandbox_runs"."status" in ('queued', 'running');--> statement-breakpoint
UPDATE "sandbox_runs" SET
	-- Only the usage loses its nulls: a null in the output, the args or a result is data.
	"response" = jsonb_build_object(
		'output', coalesce("result"->'output', 'null'::jsonb),
		'toolCalls', (
			SELECT coalesce(jsonb_agg(
				jsonb_build_object(
					'name', c->'name',
					'args', CASE WHEN jsonb_typeof(c->'arguments') = 'object' THEN c->'arguments' ELSE '{}'::jsonb END,
					'mode', CASE c->>'source' WHEN 'real' THEN 'live' WHEN 'fixture' THEN 'recorded' ELSE 'simulated' END
				) || CASE WHEN c->>'error' IS NOT NULL
					THEN jsonb_build_object('error', jsonb_build_object('code', 'tool_failed', 'message', c->>'error'))
					ELSE jsonb_build_object('result', c->'result') END
			), '[]'::jsonb)
			FROM jsonb_array_elements(coalesce("result"->'toolCalls', '[]'::jsonb)) c
		)
	) || CASE WHEN jsonb_typeof("result"->'usage') = 'object'
		THEN jsonb_build_object('usage', jsonb_strip_nulls(("result"->'usage') - 'durationMs'))
		ELSE '{}'::jsonb END,
	"duration_ms" = ("result"->'usage'->>'durationMs')::numeric::integer,
	"error_code" = CASE WHEN "status" = 'failed' THEN 'run_failed' END,
	"reason" = coalesce("reason", "result"->'error'->>'message')
WHERE "result" IS NOT NULL;--> statement-breakpoint
UPDATE "sandbox_runs" SET "error_code" = 'timeout' WHERE "status" = 'timed_out';--> statement-breakpoint
UPDATE "sandbox_runs" SET "error_code" = 'infra_error' WHERE "status" = 'infra_error';--> statement-breakpoint
-- A run of the former runner never gets a result now. The sweep deletes its VM.
UPDATE "sandbox_runs" SET
	"status" = 'infra_error',
	"error_code" = 'infra_error',
	"reason" = 'Ratel changed how runs work. Run it again.',
	"finished_at" = now()
WHERE "status" IN ('queued', 'running');--> statement-breakpoint
ALTER TABLE "sandbox_instances" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "sandbox_instances" CASCADE;--> statement-breakpoint
DROP INDEX "sandbox_runs_open_idx";--> statement-breakpoint
CREATE INDEX "sandbox_runs_open_idx" ON "sandbox_runs" USING btree ("created_at") WHERE "sandbox_runs"."status" in ('queued', 'running') or ("sandbox_runs"."started_at" is not null and "sandbox_runs"."usage_recorded_at" is null);--> statement-breakpoint
ALTER TABLE "sandbox_runs" DROP COLUMN "result";--> statement-breakpoint
ALTER TABLE "sandbox_runs" DROP COLUMN "instance_stopped_at";
