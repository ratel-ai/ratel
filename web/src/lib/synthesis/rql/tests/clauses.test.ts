import assert from "node:assert/strict";
import { test } from "node:test";
import { compileRql } from "../compile";

const NOW = new Date("2026-11-25T12:00:00.000Z");
const FROM = "2026-11-24T12:00:00.000Z";
const TO = "2026-11-25T12:00:00.000Z";
const WINDOW = `"started_at" >= $1::timestamptz and "started_at" < $2::timestamptz`;

function compiled(text: string) {
  const result = compileRql(text, { now: NOW });
  if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
  return result;
}

test("a select of columns reads the view in the default window, with the default limit", () => {
  const result = compiled("select name, model from events");
  assert.equal(
    result.sql,
    `select "name" as "c1", "model" as "c2" from "rql"."events" where ${WINDOW} limit $3::bigint`,
  );
  assert.deepEqual(result.params, [FROM, TO, 100]);
  assert.deepEqual(result.columns, [
    { name: "name", type: "text" },
    { name: "model", type: "text" },
  ]);
  assert.equal(result.table, "events");
  assert.deepEqual(result.window, { from: FROM, to: TO });
  assert.equal(result.limit, 100);
});

test("WHERE joins the window with AND, and each literal is a parameter", () => {
  const result = compiled(
    "select trace_id from events where type = 'tool_call' and duration_ms > 1000 and cost_usd <= 0.5",
  );
  assert.equal(
    result.sql,
    `select "trace_id" as "c1" from "rql"."events" where ${WINDOW} and ((("type" = $3::text) and ("duration_ms" > $4::bigint)) and ("cost_usd" <= $5::double precision)) limit $6::bigint`,
  );
  assert.deepEqual(result.params, [FROM, TO, "tool_call", 1000, 0.5, 100]);
});

test("WHERE reads the RQL operators", () => {
  const result = compiled(
    "select name from events where status != 'ok' or name like 'chat%' or name not ilike '%x' or model in ('a', 'b') or model not in ('c') or input_tokens between 1 and 9 or input_tokens not between 2 and 3 or model is null or model is not null or not (output_tokens < 1) or -input_tokens >= 2",
  );
  assert.equal(
    result.sql,
    `select "name" as "c1" from "rql"."events" where ${WINDOW} and ((((((((((("status" <> $3::text) or ("name" like $4::text)) or ("name" not ilike $5::text)) or ("model" in ($6::text, $7::text))) or ("model" not in ($8::text))) or ("input_tokens" between $9::bigint and $10::bigint)) or ("input_tokens" not between $11::bigint and $12::bigint)) or ("model" is null)) or ("model" is not null)) or (not ("output_tokens" < $9::bigint))) or ((- "input_tokens") >= $11::bigint)) limit $13::bigint`,
  );
  assert.deepEqual(result.params, [FROM, TO, "ok", "chat%", "%x", "a", "b", "c", 1, 9, 2, 3, 100]);
});

test("a boolean column is a condition, and IS TRUE tests it", () => {
  const result = compiled("select trace_id from traces where has_error and root_error is not true");
  assert.equal(
    result.sql,
    `select "trace_id" as "c1" from "rql"."traces" where ${WINDOW} and ("has_error" and ("root_error" is not true)) limit $3::bigint`,
  );
});

test("a text literal compared with a timestamp is a timestamp parameter", () => {
  const result = compiled(
    "select trace_id from traces where started_at >= '2026-11-25' and '2026-11-25 06:30:00' > started_at and started_at < '2026-11-25T08:00:00+02:00'",
  );
  assert.equal(
    result.sql,
    `select "trace_id" as "c1" from "rql"."traces" where ${WINDOW} and ((("started_at" >= $3::timestamptz) and ($4::timestamptz > "started_at")) and ("started_at" < $5::timestamptz)) limit $6::bigint`,
  );
  assert.deepEqual(result.params, [
    FROM,
    TO,
    "2026-11-25T00:00:00.000Z",
    "2026-11-25T06:30:00.000Z",
    "2026-11-25T06:00:00.000Z",
    100,
  ]);
});

test("arithmetic reads numbers, and / divides as a number", () => {
  const result = compiled(
    "select cost_usd / output_tokens as per_token, input_tokens + output_tokens * 2 from traces",
  );
  assert.equal(
    result.sql,
    `select ("cost_usd"::double precision / "output_tokens") as "c1", ("input_tokens" + ("output_tokens" * $3::bigint)) as "c2" from "rql"."traces" where ${WINDOW} limit $4::bigint`,
  );
  assert.deepEqual(result.columns, [
    { name: "per_token", type: "number" },
    { name: "column_2", type: "integer" },
  ]);
});

test("select * lists the catalog columns of the table", () => {
  const result = compiled("select * from users");
  assert.deepEqual(
    result.columns.map((column) => column.name),
    [
      "user_id",
      "session_count",
      "trace_count",
      "error_count",
      "first_trace_at",
      "last_trace_at",
      "total_duration_ms",
      "input_tokens",
      "output_tokens",
      "cost_usd",
    ],
  );
  assert.match(
    result.sql,
    /^select "user_id" as "c1", "session_count" as "c2", .* "cost_usd" as "c10" from /,
  );
});

test("a table alias qualifies columns, and the SQL names no alias", () => {
  const result = compiled("select t.trace_id, traces.cost_usd from traces as t where t.has_error");
  assert.equal(
    result.sql,
    `select "trace_id" as "c1", "cost_usd" as "c2" from "rql"."traces" where ${WINDOW} and "has_error" limit $3::bigint`,
  );
});

test("GROUP BY groups by a column, an alias or a position", () => {
  const byColumn = compiled("select model, count(*) as calls from events group by model");
  assert.equal(
    byColumn.sql,
    `select "model" as "c1", count(*) as "c2" from "rql"."events" where ${WINDOW} group by "model" limit $3::bigint`,
  );
  assert.deepEqual(byColumn.columns, [
    { name: "model", type: "text" },
    { name: "calls", type: "integer" },
  ]);
  const byAlias = compiled(
    "select attributes['gen_ai.tool.name'] as tool, count(*) from events group by tool",
  );
  assert.equal(
    byAlias.sql,
    `select ("attributes" ->> $3::text) as "c1", count(*) as "c2" from "rql"."events" where ${WINDOW} group by "c1" limit $4::bigint`,
  );
  const byPosition = compiled(
    "select service_name, environment, count(*) from traces group by 1, 2",
  );
  assert.equal(
    byPosition.sql,
    `select "service_name" as "c1", "environment" as "c2", count(*) as "c3" from "rql"."traces" where ${WINDOW} group by "c1", "c2" limit $3::bigint`,
  );
});

test("an expression of the select matches the same expression in GROUP BY", () => {
  const result = compiled("select attributes['k'], count(*) from events group by attributes['k']");
  assert.equal(
    result.sql,
    `select ("attributes" ->> $3::text) as "c1", count(*) as "c2" from "rql"."events" where ${WINDOW} group by ("attributes" ->> $3::text) limit $4::bigint`,
  );
  assert.deepEqual(result.params, [FROM, TO, "k", 100]);
});

test("HAVING filters the groups, and reads an alias as its expression", () => {
  const result = compiled(
    "select model, count(*) as calls from events group by model having calls > 10 and sum(cost_usd) > 1.5",
  );
  assert.equal(
    result.sql,
    `select "model" as "c1", count(*) as "c2" from "rql"."events" where ${WINDOW} group by "model" having ((count(*) > $3::bigint) and (sum("cost_usd") > $4::double precision)) limit $5::bigint`,
  );
});

test("ORDER BY orders by an alias, a position or an expression, with a direction and nulls", () => {
  const result = compiled(
    "select model, count(*) as calls from events group by model order by calls desc, 1 asc nulls last, max(duration_ms) desc nulls first",
  );
  assert.equal(
    result.sql,
    `select "model" as "c1", count(*) as "c2" from "rql"."events" where ${WINDOW} group by "model" order by "c2" desc, "c1" asc nulls last, max("duration_ms") desc nulls first limit $3::bigint`,
  );
});

test("ORDER BY a column that the select does not name, in a query that does not group", () => {
  const result = compiled("select trace_id from traces order by cost_usd desc");
  assert.equal(
    result.sql,
    `select "trace_id" as "c1" from "rql"."traces" where ${WINDOW} order by "cost_usd" desc limit $3::bigint`,
  );
});

test("SELECT DISTINCT stays distinct", () => {
  const result = compiled("select distinct model from events");
  assert.equal(
    result.sql,
    `select distinct "model" as "c1" from "rql"."events" where ${WINDOW} limit $3::bigint`,
  );
});

test("LIMIT under the cap is kept as a parameter", () => {
  const result = compiled("select trace_id from traces limit 5");
  assert.equal(result.limit, 5);
  assert.deepEqual(result.params, [FROM, TO, 5]);
});

test("names in any case read as the catalog names, and an output name is unique", () => {
  const result = compiled("SELECT Model, MODEL, Count(*) FROM Events GROUP BY model");
  assert.deepEqual(result.columns, [
    { name: "model", type: "text" },
    { name: "model_2", type: "text" },
    { name: "count", type: "integer" },
  ]);
});

test("scores filter on the trace start", () => {
  const result = compiled("select scorer, avg(value) from scores group by scorer");
  assert.equal(
    result.sql,
    `select "scorer" as "c1", avg("value") as "c2" from "rql"."scores" where "trace_started_at" >= $1::timestamptz and "trace_started_at" < $2::timestamptz group by "scorer" limit $3::bigint`,
  );
});

test("<> is the same as !=", () => {
  const result = compiled("select name from events where model <> 'x'");
  assert.equal(
    result.sql,
    `select "name" as "c1" from "rql"."events" where ${WINDOW} and ("model" <> $3::text) limit $4::bigint`,
  );
});
