ALTER TABLE "sandbox_versions" ALTER COLUMN "config" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_versions" DROP COLUMN "manifest";