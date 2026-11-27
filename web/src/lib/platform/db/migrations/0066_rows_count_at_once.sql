DROP INDEX "eval_case_versions_one_draft_idx";--> statement-breakpoint
ALTER TABLE "eval_case_versions" DROP COLUMN "state";--> statement-breakpoint
ALTER TABLE "eval_case_versions" DROP COLUMN "approved_by";--> statement-breakpoint
ALTER TABLE "eval_case_versions" DROP COLUMN "approved_at";