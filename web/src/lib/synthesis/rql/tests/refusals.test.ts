import assert from "node:assert/strict";
import { test } from "node:test";
import { compileRql, type RqlErrorCode } from "../compile";
import { editDistance, nearestName } from "../domain/errors";

const NOW = new Date("2026-11-25T12:00:00.000Z");

function refused(text: string) {
  const result = compileRql(text, { now: NOW });
  if (result.ok) assert.fail(`compiled: ${text}\n${result.sql}`);
  assert.ok(result.error.message.length > 0, text);
  assert.ok(result.error.fix.length > 0, text);
  return result.error;
}

/** Each refusal: the query, its code, and a part of the fix. */
const REFUSALS: [string, RqlErrorCode, RegExp][] = [
  ["   ", "empty_query", /SELECT/],
  ["select from traces", "syntax_error", /select <columns> from <table>/],
  ["selec trace_id from traces", "syntax_error", /select <columns> from <table>/],
  ["select trace_id from traces; select 1 from traces", "multiple_statements", /one SELECT/],
  ["delete from traces", "not_a_select", /cannot change data/],
  ["insert into traces (trace_id) values ('x')", "not_a_select", /cannot change data/],
  ["update traces set cost_usd = 0", "not_a_select", /cannot change data/],
  ["drop table traces", "not_a_select", /cannot change data/],
  ["create table x (a int)", "not_a_select", /cannot change data/],
  ["truncate traces", "not_a_select", /cannot change data/],
  ["values (1)", "not_a_select", /SELECT from a table/],
  ["select trace_id from traces union select trace_id from events", "set_operation", /OR in WHERE/],
  ["with t as (select trace_id from traces) select trace_id from t", "cte", /one SELECT/],
  [
    "select e.name from events e join traces t on e.trace_id = t.trace_id",
    "join",
    /traces\.models/,
  ],
  ["select name from events, traces", "multiple_tables", /one table/],
  ["select x from (select trace_id as x from traces) s", "subquery", /one table/],
  [
    "select trace_id from traces where trace_id in (select trace_id from events)",
    "subquery",
    /one SELECT/,
  ],
  ["select (select 1) from traces", "subquery", /one SELECT/],
  ["select 1", "missing_from", /events, traces, scores, sessions, users/],
  ["select x from generate_series(1, 3)", "table_function", /events/],
  ["select trace_id from rql.traces", "unknown_table", /table name alone/],
  ["select trace_id from public.otel_spans", "unknown_table", /table name alone/],
  ["select trace_id from pg_catalog.pg_tables", "unknown_table", /table name alone/],
  ["select trace_id from trace", "unknown_table", /Did you mean traces\?/],
  ["select trace_id from otel_spans", "unknown_table", /Did you mean events\?/],
  [
    "select x from nothing_like_it",
    "unknown_table",
    /The tables are events, traces, scores, sessions, users/,
  ],
  ["select x.trace_id from traces t", "unknown_table", /qualify it with t/],
  ["select duraton_ms from traces", "unknown_column", /Did you mean duration_ms\?/],
  ["select span_class from events", "unknown_column", /Did you mean type\?/],
  ["select agent_key from events", "unknown_column", /Did you mean agent\?/],
  ["select trace_id as t from traces where t = 'x'", "unknown_column", /repeat the expression/],
  ["select trace_id from traces order by 3", "unknown_column", /from 1 to 1/],
  ["select trace_id::text from traces", "postgres_syntax", /literal of its type/],
  ["select cast(cost_usd as int) from traces", "postgres_syntax", /literal of its type/],
  ["select attributes->>'k' from events", "postgres_syntax", /attributes\['key'\]/],
  ["select attributes->'k' from events", "postgres_syntax", /attributes\['key'\]/],
  ["select trace_id from traces where models @> array['x']", "postgres_syntax", /contains/],
  ["select trace_id from traces where models && array['x']", "postgres_syntax", /contains/],
  ["select trace_id || 'x' from traces", "postgres_syntax", /RQL operators|=/],
  ["select trace_id from traces where trace_id ~ 'x'", "postgres_syntax", /LIKE/],
  ["select trace_id from traces where started_at > now()", "unknown_function", /window/],
  ["select trace_id from traces where started_at > current_timestamp", "postgres_syntax", /window/],
  ["select extract(hour from started_at) from traces", "postgres_syntax", /time_bucket/],
  ["select pg_catalog.lower(trace_id) from traces", "postgres_syntax", /RQL functions/],
  ["select trace_id from traces where trace_id = $1", "postgres_syntax", /literal/],
  ["select interval '1 hour' from traces", "postgres_syntax", /literal of its type/],
  ["select case when has_error then 1 else 0 end from traces", "unsupported_clause", /WHERE/],
  ["select count(*) over () from traces", "unsupported_clause", /GROUP BY/],
  ["select count(*) filter (where has_error) from traces", "unsupported_clause", /WHERE/],
  ["select distinct on (model) model from events", "unsupported_clause", /SELECT DISTINCT/],
  ["select trace_id from traces for update", "unsupported_clause", /only reads/],
  ["select trace_id from traces offset 10", "unsupported_clause", /LIMIT/],
  ["select trace_id from traces where cost_usd = 'cheap'", "type_mismatch", /same type/],
  ["select trace_id from traces where models = 'x'", "type_mismatch", /contains/],
  ["select trace_id from events where attributes = 'x'", "type_mismatch", /attributes\['key'\]/],
  ["select trace_id from traces where cost_usd", "type_mismatch", /duration_ms > 1000/],
  ["select trace_id from traces where has_error > false", "type_mismatch", /= or !=/],
  ["select trace_id from traces where trace_id like 1", "type_mismatch", /text/],
  ["select trace_id from traces where started_at > 'yesterday'", "invalid_literal", /ISO 8601/],
  ["select trace_id from traces where cost_usd = null", "invalid_literal", /IS NULL/],
  ["select trace_id from traces where trace_id = 'a\u0000b'", "invalid_literal", /NUL/],
  [
    "select trace_id from traces where input_tokens = 99999999999999999999",
    "invalid_literal",
    /integer/,
  ],
  ["select trace_id from traces where count(*) > 1", "aggregate_misuse", /HAVING/],
  ["select count(*) from traces group by count(*)", "aggregate_misuse", /plain columns/],
  ["select count(*) as n from traces group by n", "aggregate_misuse", /not by count/],
  ["select max(count(*)) from traces", "aggregate_misuse", /second query/],
  ["select model, count(*) from events", "ungrouped_column", /Add model to GROUP BY/],
  ["select model, count(*) from events group by name", "ungrouped_column", /Add model to GROUP BY/],
  ["select model from events group by name", "ungrouped_column", /Add model to GROUP BY/],
  ["select count(*) from events order by model", "ungrouped_column", /Add model to GROUP BY/],
  ["select * from traces group by trace_id", "ungrouped_column", /GROUP BY/],
  ["select trace_id from traces limit 'ten'", "invalid_limit", /LIMIT 100/],
  ["select trace_id from traces limit -5", "invalid_limit", /LIMIT 100/],
  ["select count(*, 1) from traces", "wrong_arguments", /count/],
  ["select count(distinct *) from traces", "wrong_arguments", /count\(distinct x\)/],
  ["select sum(*) from traces", "wrong_arguments", /Name the columns/],
];

test("each refusal has its code and a fix", () => {
  for (const [text, code, fix] of REFUSALS) {
    const error = refused(text);
    assert.equal(error.code, code, `${text}: ${error.message}`);
    assert.match(error.fix, fix, text);
  }
});

test("an error names the place in the query text", () => {
  const text = "select trace_id, duraton_ms from traces";
  const error = refused(text);
  assert.ok(error.at);
  assert.equal(text.slice(error.at.start, error.at.end), "duraton_ms");
});

test("an unknown column lists the columns of the table", () => {
  const error = refused("select nope_nope_nope from sessions");
  assert.equal(error.code, "unknown_column");
  assert.equal(error.message, "The table sessions has no column nope_nope_nope.");
  assert.match(error.fix, /^The columns of sessions are session_id, user_id, trace_count, /);
});

test("end_user_id is refused on each table with user_id, and the fix suggests user_id", () => {
  for (const table of ["events", "traces", "scores", "sessions", "users"]) {
    const error = refused(`select end_user_id from ${table}`);
    assert.equal(error.code, "unknown_column", table);
    assert.match(error.fix, /^Did you mean user_id\? /, table);
  }
});

test("nearestName reads hints first, then the edit distance, and gives up when far", () => {
  const tables = [{ name: "events", hints: ["spans"] }, { name: "traces" }];
  assert.equal(nearestName("spans", tables), "events");
  assert.equal(nearestName("SPANS", tables), "events");
  assert.equal(nearestName("tracse", tables), "traces");
  assert.equal(nearestName("evnts", tables), "events");
  assert.equal(nearestName("completely_other", tables), undefined);
  assert.equal(editDistance("kitten", "sitting"), 3);
  assert.equal(editDistance("", "abc"), 3);
});
