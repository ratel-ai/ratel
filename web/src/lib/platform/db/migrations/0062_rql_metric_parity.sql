-- RTL-388: RQL reads what the metric form reads, so each metric widget can run RQL.
-- rql.traces gets known_at: when the trace's summary was last written. A window by known time
-- (an alert rule) applies to it, as the form counts by s.updated_at.
-- rql.scores gets the trace columns the trace filter reads: mcp_servers, and the trace's error,
-- tokens and cost, null when the trace is gone (as the form's left join gives them).
-- rql.prompts is the sixth view: one row per captured prompt (event_metrics), with the input
-- tokens of each source of its context, as the context measures of the form read them.
-- CREATE OR REPLACE VIEW keeps the columns and their order and adds new ones at the end, so the
-- grants of 0057 stay. Each view keeps only the rows of the project in rql.project_id, and is a
-- security_barrier, as in 0057.
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
  t.updated_at AS known_at
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
  t.cost_usd AS trace_cost_usd
FROM public.trace_scores sc
JOIN public.trace_scorers c ON c.id = sc.scorer_id AND c.project_id = sc.project_id
LEFT JOIN public.otel_trace_summaries t
  ON t.project_id = sc.project_id AND t.trace_id = sc.trace_id
WHERE sc.project_id = nullif(current_setting('rql.project_id', true), '')::uuid;--> statement-breakpoint
CREATE OR REPLACE VIEW "rql"."prompts" WITH (security_barrier = true) AS
SELECT
  m.event_time AS occurred_at,
  e.provider,
  e.model,
  m.input_tokens,
  m.output_tokens,
  coalesce((m.tokens_by_category ->> 'skills')::numeric, 0)
    + coalesce((m.tokens_by_category ->> 'tools')::numeric, 0)
    + coalesce((m.tokens_by_category ->> 'history')::numeric, 0)
    + coalesce((m.tokens_by_category ->> 'memory')::numeric, 0)
    + coalesce((m.tokens_by_category ->> 'user_input')::numeric, 0) AS context_tokens,
  coalesce((m.tokens_by_category ->> 'skills')::numeric, 0) AS skills_tokens,
  coalesce((m.tokens_by_category ->> 'tools')::numeric, 0) AS tools_tokens,
  coalesce((m.tokens_by_category ->> 'history')::numeric, 0) AS history_tokens,
  coalesce((m.tokens_by_category ->> 'memory')::numeric, 0) AS memory_tokens,
  coalesce((m.tokens_by_category ->> 'user_input')::numeric, 0) AS user_input_tokens,
  m.cost_usd,
  m.latency_ms
FROM public.event_metrics m
JOIN public.events e ON e.id = m.event_id AND e.project_id = m.project_id
WHERE m.project_id = nullif(current_setting('rql.project_id', true), '')::uuid;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ratel_rql') THEN
    GRANT SELECT ON "rql"."prompts" TO ratel_rql;
  ELSE
    RAISE WARNING 'RQL is off: the role ratel_rql does not exist. A superuser must run the DO block of migration 0057_rql_views, then: GRANT SELECT ON rql.prompts TO ratel_rql;';
  END IF;
END
$$;
