# 11. RQL: a neutral read-only query language, behind two walls

## Status

Accepted. The compiler, the views, the role, the runner (`web/src/lib/synthesis/rql`) and the MCP
tools `describe_rql_schema` and `run_rql` are in place, behind `FF_RQL` (off by default).

## Context

Agents ask questions of their own trace data that the console pages do not answer: "which tool
fails most often since Monday", "the p95 of the traces that called gpt-4o". An agent writes SQL
well, and the MCP server is the place where it asks. Raw SQL on the platform database is not
possible: the tables hold every tenant, their names and shapes change with each migration, and
Postgres has many ways to read or change what a tenant must not see (functions, casts to `regclass`,
`pg_*` catalogs, `set role`, a second statement).

A text filter on SQL (deny lists, regexes) fails open: one form that it does not know passes.

## Decision

**A language of our own, RQL version 1.** One `SELECT` over one of five virtual tables, with
`WHERE`, `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT` and `SELECT DISTINCT`:

| Table | One row per | Window on |
|---|---|---|
| `events` | span (`otel_spans`); `type` is `llm_call`, `tool_call`, `search`, `agent_run` or `other` | `started_at` |
| `traces` | trace (`otel_trace_summaries`) | `started_at` |
| `scores` | scorer and trace (`trace_scores`, the scorer name, copied trace columns) | `trace_started_at` |
| `sessions` | session: totals of its traces | its traces' `started_at` |
| `users` | end user: totals of their traces | its traces' `started_at` |

`events.type` comes from `span_class`: `llm_call` gives `llm_call`, `tool` gives `tool_call` and
`ratel_search` gives `search`. A span of another class with the gen_ai agent operation
`invoke_agent` or `create_agent` gives `agent_run`. Each other span gives `other`.

The end user is `user_id` in each table that has it (`events`, `traces`, `scores`, `sessions`,
`users`). The storage column keeps the name `end_user_id`, and the views give it the alias
`user_id`. A query that names `end_user_id` is refused, and the fix suggests `user_id`.

The catalog (`domain/catalog.ts`) lists each table, column, type and description, and the
language version. RQL has no join: each table copies the trace columns that a question needs.
RQL refuses joins, `UNION`, `WITH`, subqueries, `CASE`, window functions, `OFFSET`, writes, a
second statement and each name that is not in the catalog. Each refusal has a code, a message
and a fix; an unknown name gets the nearest one by edit distance or a hint.

**Neutral functions, no Postgres syntax.** `count` (with `*` and `distinct`), `count_distinct`,
`sum`, `avg`, `min`, `max`, `p50`/`p90`/`p95`/`p99`, `percentile(x, f)`,
`time_bucket('<n> minute|hour|day|week', ts)`, `contains(list, value)` for `models`, `tools`,
`agents` and `mcp_servers`, and `attributes['key']`. The rewrite maps them to Postgres
(`percentile_cont ... within group`, `date_bin`, `@> array[...]`, `->>`). The user cannot write
`::`, `->>`, `date_trunc`, `jsonb_*`, `@>`, `$1` or `now()`: the error names the RQL form. The
functions belong to the language, not to Postgres, so a later engine can run the same queries.

**Wall 1: the compiler.** `compileRql(text, { now, window? })` parses with `pgsql-ast-parser`
(behind the `RqlParser` port), checks the tree against the catalog, and prints its own SQL from
the checked tree. Each name in the SQL is a catalog name, each output column is `c1`, `c2`... (the
result names come back in `columns`), and each literal is a bound parameter (`$1`, `$2`...). No
text of the query reaches the database, comments included. The window is always `$1` and `$2`:
the caller gives it (by default the last 24 hours, at most 30 days), never the query text, and a
time filter in `WHERE` can only narrow it. The `LIMIT` is lowered to a cap (1000; 100 when the
query has none). The bounds are in `domain/limits.ts`.

**Wall 2: the database.** The compiled SQL reads only the views `rql.events`, `rql.traces`,
`rql.scores`, `rql.sessions` and `rql.users`. Each view filters on a per-transaction project
setting, and they are `security_barrier` views: the planner applies that filter before any
condition of the query, so a condition that fails cannot test another project's rows. The runner
executes the SQL as the role `ratel_rql`, which can read only those views,
in a read-only transaction with a statement timeout and a per-project cap on parallel queries.
A compiler bug then gives at most a wrong answer about the same project, not another tenant's
rows or a write.

**Sessions and users: the window applies to the traces, before the totals.** The views
`rql.sessions` and `rql.users` give one row per trace (of a session, of an end user). The compiler
emits a windowed derived query: it filters those trace rows on the window, groups them by
`session_id` or `user_id` into the totals columns (`trace_count`, `error_count`,
`first_trace_at`, `last_trace_at`, `total_duration_ms`, tokens, `cost_usd`, `session_count` for
users), and the query's own `WHERE`, `GROUP BY` and the rest apply to those totals. A view that
held the totals could not take the window: a session's total over all time is not its total in
the window. The views stay simple filters, and the totals have one definition, in the catalog.

**One catalog, two uses.** `describeRqlSchema()` gives the MCP tool `describe_rql_schema` the
same tables, columns, functions, limits, rules and examples that the compiler checks against. A
test compiles every example.

## Consequences

- A new column, table or function is a change of the catalog, of the views and of the
  description, in one place each. A change of a name or a meaning is a new language version.
- Questions that need a join (span detail of the failed traces of one scorer) need two queries,
  or a column copied into the table. That is the price of a language that a tenant cannot escape.
- The views must expose exactly the catalog columns (`web/src/lib/synthesis/rql/README.md` lists
  them per view); a missing column is a runtime error, not a compile error.
- `pgsql-ast-parser` is a lexer and parser of Postgres in JavaScript, not Postgres itself. Its
  reading is the only reading, as the SQL is printed again: a form it reads otherwise than
  Postgres gives a refusal or another checked query, never text for the database. Its lexer
  reads a quote, a backslash, `--`, a nested `/*` and a non-ASCII character in a block comment
  otherwise than Postgres: the compiler then refuses the query.
