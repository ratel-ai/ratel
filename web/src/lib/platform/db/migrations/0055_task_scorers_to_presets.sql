CREATE TABLE "task_preset_seeds" (
	"project_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"kind" text NOT NULL,
	"seeded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_preset_seeds_project_id_task_id_kind_pk" PRIMARY KEY("project_id","task_id","kind")
);
--> statement-breakpoint
ALTER TABLE "trace_scorers" DROP CONSTRAINT "trace_scorers_kind_check";--> statement-breakpoint
ALTER TABLE "task_preset_seeds" ADD CONSTRAINT "task_preset_seeds_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_scorers" ADD CONSTRAINT "trace_scorers_kind_check" CHECK ("trace_scorers"."kind" in ('check', 'judge', 'preset'));--> statement-breakpoint
-- Each task scorer becomes a scorer attached to its task (`views/scorers`): the 6 measured kinds as
-- presets, `judge_criteria` as a pass-or-fail judge. A preset keeps `enabled`. A judge starts
-- disabled: the task's criteria made no model call before, so nothing starts to spend until a person
-- turns it on. A row whose settings do not parse is left out, as `task-scorers/store.ts` refuses it.
-- A task that already has the converted scorer is left alone, so a second run adds nothing.
-- `task_scores_daily` is not converted. The converted scorers are the system's
-- (`system:task-scorers`): they do not count against the limit of 100 scorers (`MAX_SCORERS`).
WITH "source" AS (
	SELECT
		gen_random_uuid() AS "id",
		ts."project_id",
		ts."task_id",
		CASE WHEN ts."kind" = 'judge_criteria' THEN false ELSE ts."enabled" END AS "enabled",
		ts."updated_by",
		CASE WHEN ts."kind" = 'judge_criteria' THEN 'judge' ELSE 'preset' END AS "kind",
		CASE ts."kind"
			WHEN 'judge_criteria' THEN jsonb_build_object('prompt', btrim(ts."config"->>'criteria'), 'output', 'boolean')
			WHEN 'ends_well' THEN jsonb_build_object('preset', ts."kind")
			WHEN 'expected_tool' THEN jsonb_build_object('preset', ts."kind", 'tool', btrim(ts."config"->>'tool'))
			ELSE jsonb_build_object('preset', ts."kind", 'max', ts."config"->'max')
		END AS "config",
		left(
			CASE ts."kind"
				WHEN 'judge_criteria' THEN 'Task criteria'
				WHEN 'ends_well' THEN 'Finishes cleanly'
				WHEN 'max_self_corrections' THEN 'Self-corrections'
				WHEN 'max_latency_ms' THEN 'Run time'
				WHEN 'max_cost_usd' THEN 'Cost per run'
				WHEN 'expected_tool' THEN 'Expected tool'
				ELSE 'Tool calls'
			END || ' · ' || ts."task_id",
			100
		) AS "name",
		ts."kind" AS "task_kind"
	FROM "task_scorers" ts
	WHERE CASE ts."kind"
			WHEN 'judge_criteria' THEN coalesce(length(btrim(ts."config"->>'criteria')) BETWEEN 1 AND 5000, false)
			WHEN 'ends_well' THEN true
			WHEN 'expected_tool' THEN coalesce(length(btrim(ts."config"->>'tool')) BETWEEN 1 AND 500, false)
			ELSE jsonb_typeof(ts."config"->'max') = 'number' AND (ts."config"->>'max')::numeric >= 0
		END
		AND NOT EXISTS (
			SELECT 1 FROM "trace_scorer_tasks" l
			JOIN "trace_scorers" c ON c."id" = l."scorer_id"
			WHERE l."project_id" = ts."project_id" AND l."task_id" = ts."task_id"
				AND c."created_by" = 'system:task-scorers'
				AND CASE WHEN ts."kind" = 'judge_criteria' THEN c."kind" = 'judge'
					ELSE c."kind" = 'preset' AND c."config"->>'preset' = ts."kind" END
		)
		-- Given once: a converted scorer that a person later deleted is not converted again.
		AND NOT EXISTS (
			SELECT 1 FROM "task_preset_seeds" s
			WHERE s."project_id" = ts."project_id" AND s."task_id" = ts."task_id" AND s."kind" = ts."kind"
		)
),
"scorers" AS (
	INSERT INTO "trace_scorers" ("id", "project_id", "name", "kind", "config", "scope", "enabled", "created_by", "updated_by")
	SELECT "id", "project_id", "name", "kind", "config", 'tasks', "enabled", 'system:task-scorers', "updated_by" FROM "source"
),
"links" AS (
	INSERT INTO "trace_scorer_tasks" ("scorer_id", "task_id", "project_id")
	SELECT "id", "task_id", "project_id" FROM "source"
)
-- Each converted kind is recorded, so the runtime seed (`task-presets.ts`) does not give it again.
INSERT INTO "task_preset_seeds" ("project_id", "task_id", "kind")
SELECT "project_id", "task_id", "task_kind" FROM "source"
ON CONFLICT DO NOTHING;
