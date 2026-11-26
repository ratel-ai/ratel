ALTER TABLE "sandbox_instances" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "sandbox_instances" CASCADE;--> statement-breakpoint
DROP INDEX "sandbox_runs_open_idx";--> statement-breakpoint
CREATE INDEX "sandbox_runs_open_idx" ON "sandbox_runs" USING btree ("created_at") WHERE "sandbox_runs"."status" in ('queued', 'running') or ("sandbox_runs"."started_at" is not null and "sandbox_runs"."usage_recorded_at" is null);--> statement-breakpoint
ALTER TABLE "sandbox_runs" DROP COLUMN "result";--> statement-breakpoint
ALTER TABLE "sandbox_runs" DROP COLUMN "instance_stopped_at";