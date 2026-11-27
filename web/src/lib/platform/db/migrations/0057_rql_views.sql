-- RTL-323: the read-only path of RQL (lib/synthesis/rql). The schema "rql" holds the five views
-- the compiler reads, and the role ratel_rql can read them and nothing else.
-- Each view keeps only the rows of the project in the transaction setting rql.project_id. The
-- runner sets it with set_config(..., true), so it ends with the transaction. Unset or empty, a
-- view gives no row.
-- events.type: the span_class llm_call, tool and ratel_search give llm_call, tool_call and search.
-- A span of another class with the gen_ai agent operation invoke_agent or create_agent gives
-- agent_run (an agent wrapper that ingest dedupes has the class other). Each other span is other.
-- The views give the storage column end_user_id the RQL name user_id.
-- Each view is a security_barrier: the planner applies its project filter before any condition of
-- the query, so a condition that fails (a division by zero) never runs on another project's row.
-- The views run with the rights of their owner (the user that runs the migrations), not with
-- security_invoker. So ratel_rql reads the base tables only through the views, and has no grant
-- on a base table.
-- The role: NOLOGIN, USAGE on the schema rql and SELECT on its views only. The runner does
-- SET LOCAL ROLE ratel_rql, so the user that connects must be a member: this migration grants
-- the role to the user that runs it. If RQL_DATABASE_URL names another user, grant it by hand:
--   GRANT ratel_rql TO <that user>;
-- A physical replica gets the role, the views and the grants from the primary.
-- When the migration user cannot CREATE ROLE (or cannot grant the role), the migration does not
-- fail, so a self-hosted boot continues: it gives a WARNING, and RQL queries fail with the code
-- rql_unavailable until a superuser runs the DO block below again.
CREATE SCHEMA IF NOT EXISTS "rql";--> statement-breakpoint
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
  s.attributes
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
  t.end_user_id AS user_id
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
  t.agents
FROM public.trace_scores sc
JOIN public.trace_scorers c ON c.id = sc.scorer_id
LEFT JOIN public.otel_trace_summaries t
  ON t.project_id = sc.project_id AND t.trace_id = sc.trace_id
WHERE sc.project_id = nullif(current_setting('rql.project_id', true), '')::uuid;--> statement-breakpoint
CREATE OR REPLACE VIEW "rql"."sessions" WITH (security_barrier = true) AS
SELECT
  t.trace_id,
  t.session_id,
  t.end_user_id AS user_id,
  t.started_at,
  t.duration_ms,
  t.has_error,
  t.input_tokens,
  t.output_tokens,
  t.cost_usd
FROM public.otel_trace_summaries t
WHERE t.project_id = nullif(current_setting('rql.project_id', true), '')::uuid
  AND t.session_id IS NOT NULL;--> statement-breakpoint
CREATE OR REPLACE VIEW "rql"."users" WITH (security_barrier = true) AS
SELECT
  t.trace_id,
  t.session_id,
  t.end_user_id AS user_id,
  t.started_at,
  t.duration_ms,
  t.has_error,
  t.input_tokens,
  t.output_tokens,
  t.cost_usd
FROM public.otel_trace_summaries t
WHERE t.project_id = nullif(current_setting('rql.project_id', true), '')::uuid
  AND t.end_user_id IS NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ratel_rql') THEN
    BEGIN
      CREATE ROLE ratel_rql NOLOGIN;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'RQL is off: user % cannot CREATE ROLE ratel_rql. A superuser must run the DO block of migration 0057_rql_views.', current_user;
      RETURN;
    END;
  END IF;
  GRANT USAGE ON SCHEMA "rql" TO ratel_rql;
  GRANT SELECT ON ALL TABLES IN SCHEMA "rql" TO ratel_rql;
  IF current_user <> 'ratel_rql' THEN
    BEGIN
      EXECUTE format('GRANT ratel_rql TO %I', current_user);
    EXCEPTION WHEN insufficient_privilege OR invalid_grant_operation THEN
      RAISE WARNING 'RQL is off: user % cannot be granted ratel_rql. A superuser must run: GRANT ratel_rql TO %;', current_user, current_user;
    END;
  END IF;
END
$$;
