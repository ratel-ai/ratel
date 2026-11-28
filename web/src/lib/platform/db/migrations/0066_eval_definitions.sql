CREATE TABLE "eval_definition_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"eval_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"sandbox_name" text,
	"params" jsonb NOT NULL,
	"trials" integer NOT NULL,
	"scorers" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"task_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "eval_id" uuid;--> statement-breakpoint
ALTER TABLE "eval_experiments" ADD COLUMN "eval_versions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_definition_versions" ADD CONSTRAINT "eval_definition_versions_eval_id_eval_definitions_id_fk" FOREIGN KEY ("eval_id") REFERENCES "public"."eval_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_definitions" ADD CONSTRAINT "eval_definitions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "eval_definition_versions_eval_number_idx" ON "eval_definition_versions" USING btree ("eval_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_definitions_project_name_idx" ON "eval_definitions" USING btree ("project_id","name");--> statement-breakpoint
-- Each existing case goes into an eval made from its `task:` label and its scorer set: the scorers
-- of its newest approved version, else of its newest version. Cases with the same label and the
-- same scorers share an eval. Scorer ids are random per case, so the match ignores them, and the
-- eval keeps the scorers of its oldest case. The eval is named after the label (`Evals` with none),
-- and a second scorer set of the same label gets the first free number. A label is a task name, not
-- a task id: task_id stays null. Experiments keep their frozen scorer snapshots, so they read as before.
CREATE TEMPORARY TABLE "eval_case_groups" AS
SELECT
	x.*,
	coalesce(
		(SELECT jsonb_agg(e."scorer" - 'id' ORDER BY e."position") FROM jsonb_array_elements(x."scorers") WITH ORDINALITY AS e("scorer", "position")),
		'[]'::jsonb
	) AS "shape"
FROM (
	SELECT
		c."id" AS "case_id",
		c."project_id",
		c."created_by",
		c."created_at",
		coalesce(
			(SELECT nullif(btrim(substr(l, 6)), '') FROM unnest(c."labels") AS l WHERE lower(l) LIKE 'task:%' LIMIT 1),
			'Evals'
		) AS "base",
		coalesce(
			(SELECT v."scorers" FROM "eval_case_versions" v WHERE v."case_id" = c."id"
				ORDER BY (v."state" = 'approved') DESC, v."number" DESC LIMIT 1),
			'[]'::jsonb
		) AS "scorers"
	FROM "eval_cases" c
) x;--> statement-breakpoint
CREATE TEMPORARY TABLE "eval_case_sets" AS
SELECT
	gen_random_uuid() AS "id",
	g."project_id",
	g."base",
	g."shape",
	g."scorers",
	g."first_at",
	g."created_by",
	g."rank",
	CASE WHEN g."rank" = 1 THEN g."base" END AS "name"
FROM (
	SELECT
		"project_id",
		"base",
		"shape",
		(array_agg("scorers" ORDER BY "created_at", "case_id"))[1] AS "scorers",
		min("created_at") AS "first_at",
		(array_agg("created_by" ORDER BY "created_at", "case_id"))[1] AS "created_by",
		row_number() OVER (PARTITION BY "project_id", "base" ORDER BY min("created_at"), "shape"::text) AS "rank"
	FROM "eval_case_groups"
	GROUP BY "project_id", "base", "shape"
) g;--> statement-breakpoint
-- A label can read like a numbered name (`X #2`), so each numbered name takes the first free number.
DO $$
DECLARE
	s record;
	n integer;
BEGIN
	FOR s IN SELECT "id", "project_id", "base", "rank" FROM "eval_case_sets" WHERE "name" IS NULL ORDER BY "project_id", "base", "rank" LOOP
		n := s."rank";
		WHILE EXISTS (SELECT 1 FROM "eval_case_sets" WHERE "project_id" = s."project_id" AND "name" = s."base" || ' #' || n) LOOP
			n := n + 1;
		END LOOP;
		UPDATE "eval_case_sets" SET "name" = s."base" || ' #' || n WHERE "id" = s."id";
	END LOOP;
END $$;--> statement-breakpoint
INSERT INTO "eval_definitions" ("id", "project_id", "name", "task_id", "created_by", "created_at")
SELECT "id", "project_id", "name", NULL, "created_by", "first_at" FROM "eval_case_sets";--> statement-breakpoint
INSERT INTO "eval_definition_versions" ("eval_id", "number", "sandbox_name", "params", "trials", "scorers", "created_by", "created_at")
SELECT "id", 1, NULL, '{}'::jsonb, 3, "scorers", "created_by", "first_at" FROM "eval_case_sets";--> statement-breakpoint
UPDATE "eval_cases" c SET "eval_id" = s."id"
FROM "eval_case_groups" g
JOIN "eval_case_sets" s ON s."project_id" = g."project_id" AND s."base" = g."base" AND s."shape" = g."shape"
WHERE g."case_id" = c."id";--> statement-breakpoint
DROP TABLE "eval_case_groups";--> statement-breakpoint
DROP TABLE "eval_case_sets";--> statement-breakpoint
ALTER TABLE "eval_cases" ALTER COLUMN "eval_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_eval_id_eval_definitions_id_fk" FOREIGN KEY ("eval_id") REFERENCES "public"."eval_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_cases_eval_idx" ON "eval_cases" USING btree ("eval_id");--> statement-breakpoint
ALTER TABLE "eval_case_versions" DROP COLUMN "scorers";