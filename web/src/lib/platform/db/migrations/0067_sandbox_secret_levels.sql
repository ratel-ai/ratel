ALTER TABLE "sandbox_secrets" DROP CONSTRAINT "sandbox_secrets_project_id_name_pk";--> statement-breakpoint
ALTER TABLE "sandbox_secrets" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_secrets" ADD COLUMN "sandbox_name" text;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_secrets_project_name_idx" ON "sandbox_secrets" USING btree ("project_id","name") WHERE "sandbox_secrets"."sandbox_name" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_secrets_sandbox_name_idx" ON "sandbox_secrets" USING btree ("project_id","sandbox_name","name") WHERE "sandbox_secrets"."sandbox_name" is not null;