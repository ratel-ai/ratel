-- RTL-397 (ADR-0011, ADR-0012): RQL reads the tasks of a trace. rql.traces and rql.scores get a
-- last column, tasks: the ids of the tasks (Agent health workflows) the trace ran in, sorted. A run
-- of a task is a trace_turns row with its workflow_id: the trace's own OTLP turn (turn_key
-- 'otlp:<trace id>', on trace_turns_project_turn_key_idx), or a turn with a step on an event of the
-- trace (trace_events_project_trace_idx, then the index above), as the scorers of tasks and the
-- console's task filter read them. A trace can be a step of more than one turn, so the column is a
-- list: contains(tasks, 'id') filters, each(tasks) groups. CREATE OR REPLACE VIEW keeps the columns
-- and their order and adds the new one at the end, so the grants of 0057 stay. Each view keeps only
-- the rows of the project in rql.project_id, and is a security_barrier, as in 0057; the runs are
-- read with the project of the row, never another's. A score whose trace summary is gone has no
-- task, as it has no other trace column: the metric form reads it the same way.
-- The index on trace_turn_steps scans the table one time, and the migrator runs every pending
-- migration in one transaction, where a plain CREATE INDEX blocks writes to the table for that scan.
-- To avoid the block on a large database, run this on production before the deploy, outside a
-- transaction (psql autocommit):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "trace_turn_steps_project_event_idx" ON "trace_turn_steps" USING btree ("project_id","trace_event_id");
-- The statement below is then a no-op. If a CONCURRENTLY build fails it leaves an INVALID index:
-- DROP INDEX CONCURRENTLY it and run it again.
CREATE INDEX IF NOT EXISTS "trace_turn_steps_project_event_idx" ON "trace_turn_steps" USING btree ("project_id","trace_event_id");--> statement-breakpoint
CREATE OR REPLACE VIEW "rql"."traces" WITH (security_barrier = true) AS
SELECT
  t.trace_id,
  t.started_at,
  t.duration_ms,
  t.has_error,
  t.root_error,
  t.input_tokens,
  t.output_tokens,
  t.cost_usd,
  t.models,
  t.tools,
  t.agents,
  t.mcp_servers,
  t.service_name,
  t.environment,
  t.geo_country,
  t.session_id,
  t.end_user_id AS user_id,
  t.updated_at AS known_at,
  t.properties,
  array(
    SELECT x.workflow_id FROM (
      SELECT tt.workflow_id FROM public.trace_turns tt
      WHERE tt.project_id = t.project_id AND tt.turn_key = 'otlp:' || t.trace_id
        AND tt.workflow_id IS NOT NULL
      UNION
      SELECT tt.workflow_id FROM public.trace_events e
      JOIN public.trace_turn_steps st ON st.project_id = e.project_id AND st.trace_event_id = e.id
      JOIN public.trace_turns tt ON tt.project_id = st.project_id AND tt.id = st.turn_id
      WHERE e.project_id = t.project_id AND e.trace_id = t.trace_id AND tt.workflow_id IS NOT NULL
    ) x ORDER BY x.workflow_id
  )::text[] AS tasks
FROM public.otel_trace_summaries t
WHERE t.project_id = nullif(current_setting('rql.project_id', true), '')::uuid;--> statement-breakpoint
CREATE OR REPLACE VIEW "rql"."scores" WITH (security_barrier = true) AS
SELECT
  sc.scorer_id::text AS scorer_id,
  c.name AS scorer,
  c.kind AS scorer_kind,
  sc.trace_id,
  sc.value,
  sc.passed,
  sc.confidence,
  sc.scored_at,
  sc.trace_started_at,
  t.session_id,
  t.end_user_id AS user_id,
  t.service_name,
  t.environment,
  t.models,
  t.tools,
  t.agents,
  t.mcp_servers,
  t.has_error AS trace_has_error,
  t.input_tokens AS trace_input_tokens,
  t.output_tokens AS trace_output_tokens,
  t.cost_usd AS trace_cost_usd,
  coalesce(t.properties, '{}'::jsonb) AS properties,
  array(
    SELECT x.workflow_id FROM (
      SELECT tt.workflow_id FROM public.trace_turns tt
      WHERE tt.project_id = t.project_id AND tt.turn_key = 'otlp:' || t.trace_id
        AND tt.workflow_id IS NOT NULL
      UNION
      SELECT tt.workflow_id FROM public.trace_events e
      JOIN public.trace_turn_steps st ON st.project_id = e.project_id AND st.trace_event_id = e.id
      JOIN public.trace_turns tt ON tt.project_id = st.project_id AND tt.id = st.turn_id
      WHERE e.project_id = t.project_id AND e.trace_id = t.trace_id AND tt.workflow_id IS NOT NULL
    ) x ORDER BY x.workflow_id
  )::text[] AS tasks
FROM public.trace_scores sc
JOIN public.trace_scorers c ON c.id = sc.scorer_id AND c.project_id = sc.project_id
LEFT JOIN public.otel_trace_summaries t
  ON t.project_id = sc.project_id AND t.trace_id = sc.trace_id
WHERE sc.project_id = nullif(current_setting('rql.project_id', true), '')::uuid;
