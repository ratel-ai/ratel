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
WHERE "image_digest" IS NULL AND "status" <> 'failed';
