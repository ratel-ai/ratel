-- RTL-396 (ADR-0011, ADR-0012): RQL reads the trace properties with properties['name']. The
-- views rql.traces, rql.events and rql.scores get a last column, properties: the indexed values of
-- the trace's summary (traces), of the span (events: its own value, else an ancestor's, else its
-- resource's, as ingest writes otel_spans.properties) and of the scored trace (scores; empty when
-- the trace is gone). rql.sessions and rql.users have none: a session's traces can hold different
-- values. The compiler reads one key at a time, by a bound value, and only a key the project
-- indexes. CREATE OR REPLACE VIEW keeps the columns and their order and adds the new one at the
-- end, so the grants of 0057 stay. Each view keeps only the rows of the project in
-- rql.project_id, and is a security_barrier, as in 0057.
CREATE OR REPLACE VIEW "rql"."events" WITH (security_barrier = true) AS
SELECT
  s.trace_id,
  s.span_id,
  s.parent_span_id,
  s.name,
  CASE
    WHEN s.span_class = 'llm_call' THEN 'llm_call'
    WHEN s.span_class = 'tool' THEN 'tool_call'
    WHEN s.span_class = 'ratel_search' THEN 'search'
    WHEN s.operation_name IN ('invoke_agent', 'create_agent') THEN 'agent_run'
    ELSE 'other'
  END AS type,
  CASE s.status_code WHEN 1 THEN 'ok' WHEN 2 THEN 'error' ELSE 'unset' END AS status,
  s.started_at,
  s.ended_at,
  s.duration_ms,
  s.service_name,
  s.operation_name AS operation,
  s.provider_name AS provider,
  s.model,
  s.input_tokens,
  s.output_tokens,
  s.cached_tokens,
  s.reasoning_tokens,
  s.cost_usd,
  s.agent_key AS agent,
  s.caller_agent_key AS caller_agent,
  s.mcp_server,
  s.experiment_name,
  s.experiment_arm,
  s.session_id,
  s.end_user_id AS user_id,
  s.attributes,
  coalesce(s.properties, '{}'::jsonb) AS properties
FROM public.otel_spans s
WHERE s.project_id = nullif(current_setting('rql.project_id', true), '')::uuid;--> statement-breakpoint
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
  t.properties
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
  coalesce(t.properties, '{}'::jsonb) AS properties
FROM public.trace_scores sc
JOIN public.trace_scorers c ON c.id = sc.scorer_id AND c.project_id = sc.project_id
LEFT JOIN public.otel_trace_summaries t
  ON t.project_id = sc.project_id AND t.trace_id = sc.trace_id
WHERE sc.project_id = nullif(current_setting('rql.project_id', true), '')::uuid;
