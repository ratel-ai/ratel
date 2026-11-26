CREATE TABLE "sandbox_vms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"vm_ref" text,
	"state" text DEFAULT 'starting' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
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
WHERE "result" IS NOT NULL;
--> statement-breakpoint
UPDATE "sandbox_runs" SET "error_code" = 'timeout' WHERE "status" = 'timed_out';--> statement-breakpoint
UPDATE "sandbox_runs" SET "error_code" = 'infra_error' WHERE "status" = 'infra_error';--> statement-breakpoint
-- A run of the former runner never gets a result now. The sweep deletes its VM.
UPDATE "sandbox_runs" SET
	"status" = 'infra_error',
	"error_code" = 'infra_error',
	"reason" = 'Ratel changed how runs work. Run it again.',
	"finished_at" = now()
WHERE "status" IN ('queued', 'running');
