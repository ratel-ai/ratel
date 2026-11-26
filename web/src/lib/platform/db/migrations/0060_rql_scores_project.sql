-- RTL-384: the view rql.scores joins a scorer of the same project only. A score row and its scorer
-- have the same project today, so no answer changes: the condition makes the view keep its project
-- by its own text, not by the integrity of trace_scores. CREATE OR REPLACE keeps the grants of
-- 0057 (SELECT to ratel_rql), the columns and their order.
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
  t.agents
FROM public.trace_scores sc
JOIN public.trace_scorers c ON c.id = sc.scorer_id AND c.project_id = sc.project_id
LEFT JOIN public.otel_trace_summaries t
  ON t.project_id = sc.project_id AND t.trace_id = sc.trace_id
WHERE sc.project_id = nullif(current_setting('rql.project_id', true), '')::uuid;
