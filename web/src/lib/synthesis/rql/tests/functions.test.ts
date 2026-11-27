import assert from "node:assert/strict";
import { test } from "node:test";
import { compileRql } from "../compile";

const NOW = new Date("2026-11-25T12:00:00.000Z");
const FROM = "2026-11-24T12:00:00.000Z";
const TO = "2026-11-25T12:00:00.000Z";

/** The select list of the compiled SQL, and the parameters after the window. */
function selected(text: string): { items: string; params: unknown[] } {
  const result = compileRql(text, { now: NOW });
  if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
  const match = /^select (.*) from "rql"\."(?:events|traces)" where /.exec(result.sql);
  assert.ok(match, result.sql);
  assert.deepEqual(result.params.slice(0, 2), [FROM, TO]);
  return { items: match[1], params: result.params.slice(2, -1) };
}

test("count(*), count(x), count(distinct x) and count_distinct(x)", () => {
  assert.deepEqual(
    selected(
      "select count(*), count(model), count(distinct model), count_distinct(trace_id) from events",
    ),
    {
      items: `count(*) as "c1", count("model") as "c2", count(distinct "model") as "c3", count(distinct "trace_id") as "c4"`,
      params: [],
    },
  );
});

test("sum, avg, min and max", () => {
  const result = compileRql(
    "select sum(input_tokens), sum(cost_usd), avg(duration_ms), min(started_at), max(service_name) from traces",
    { now: NOW },
  );
  assert.ok(result.ok);
  assert.match(
    result.sql,
    /^select sum\("input_tokens"\) as "c1", sum\("cost_usd"\) as "c2", avg\("duration_ms"\) as "c3", min\("started_at"\) as "c4", max\("service_name"\) as "c5"/,
  );
  assert.deepEqual(
    result.columns.map((column) => column.type),
    ["integer", "number", "number", "timestamp", "text"],
  );
});

test("p50, p90, p95 and p99 are interpolated percentiles", () => {
  assert.deepEqual(
    selected(
      "select p50(duration_ms), p90(duration_ms), p95(cost_usd), p99(input_tokens) from traces",
    ),
    {
      items: `percentile_cont(0.5) within group (order by "duration_ms") as "c1", percentile_cont(0.9) within group (order by "duration_ms") as "c2", percentile_cont(0.95) within group (order by "cost_usd") as "c3", percentile_cont(0.99) within group (order by "input_tokens") as "c4"`,
      params: [],
    },
  );
});

test("percentile(x, fraction) binds the fraction", () => {
  assert.deepEqual(
    selected("select percentile(duration_ms, 0.75), percentile(duration_ms, 1) from traces"),
    {
      items: `percentile_cont($3::double precision) within group (order by "duration_ms") as "c1", percentile_cont($4::double precision) within group (order by "duration_ms") as "c2"`,
      params: [0.75, 1],
    },
  );
});

test("time_bucket is date_bin with a canonical interval parameter", () => {
  const result = compileRql(
    "select time_bucket('15 Minutes', started_at) as at, count(*) from traces group by at order by at",
    { now: NOW },
  );
  assert.ok(result.ok);
  assert.equal(
    result.sql,
    `select date_bin($3::interval, "started_at", timestamptz '2000-01-01 00:00:00+00') as "c1", count(*) as "c2" from "rql"."traces" where "started_at" >= $1::timestamptz and "started_at" < $2::timestamptz group by "c1" order by "c1" limit $4::bigint`,
  );
  assert.deepEqual(result.params, [FROM, TO, "15 minutes", 100]);
  assert.deepEqual(result.columns[0], { name: "at", type: "timestamp" });
  for (const bucket of ["1 minute", "1 hour", "2 hours", "1 day", "1 week"]) {
    assert.ok(
      compileRql(`select time_bucket('${bucket}', started_at) from traces`, { now: NOW }).ok,
    );
  }
});

test("contains tests models, tools, agents and mcp_servers", () => {
  assert.deepEqual(
    selected(
      "select contains(models, 'gpt-4o'), contains(tools, 'search'), contains(agents, 'planner'), contains(mcp_servers, 'github') from traces",
    ),
    {
      items: `("models" @> array[$3::text]) as "c1", ("tools" @> array[$4::text]) as "c2", ("agents" @> array[$5::text]) as "c3", ("mcp_servers" @> array[$6::text]) as "c4"`,
      params: ["gpt-4o", "search", "planner", "github"],
    },
  );
  const filtered = compileRql("select trace_id from traces where contains(models, 'gpt-4o')", {
    now: NOW,
  });
  assert.ok(filtered.ok && filtered.sql.includes(`and ("models" @> array[$3::text])`));
});

test("attributes['key'] reads one attribute as text", () => {
  assert.deepEqual(
    selected(
      "select attributes['gen_ai.tool.name'] from events where attributes['http.status'] = '500'",
    ),
    {
      items: `("attributes" ->> $3::text) as "c1"`,
      params: ["gen_ai.tool.name", "http.status", "500"],
    },
  );
  const result = compileRql("select attributes['gen_ai.tool.name'] from events", { now: NOW });
  assert.ok(result.ok);
  assert.deepEqual(result.columns, [{ name: "gen_ai.tool.name", type: "text" }]);
});

test("a function that is not RQL, or wrong arguments, are refused with a fix", () => {
  const cases: [string, string, RegExp][] = [
    ["select date_trunc('hour', started_at) from traces", "unknown_function", /time_bucket/],
    [
      "select jsonb_extract_path_text(attributes, 'k') from events",
      "unknown_function",
      /attributes\['key'\]/,
    ],
    [
      "select percentile_cont(0.5) within group (order by duration_ms) from traces",
      "postgres_syntax",
      /p95/,
    ],
    ["select cuont(*) from traces", "unknown_function", /Did you mean count\?/],
    ["select sum(model) from events", "type_mismatch", /type/],
    ["select avg(distinct duration_ms) from traces", "wrong_arguments", /count\(distinct x\)/],
    ["select percentile(duration_ms, 2) from traces", "wrong_arguments", /0 to 1/],
    [
      "select percentile(duration_ms) from traces",
      "wrong_arguments",
      /percentile\(number, fraction\)/,
    ],
    ["select time_bucket('1 fortnight', started_at) from traces", "wrong_arguments", /'1 hour'/],
    ["select time_bucket('1 hour', model) from events", "type_mismatch", /timestamp/],
    ["select contains(model, 'x') from events", "type_mismatch", /text_list/],
    ["select models['x'] from traces", "wrong_arguments", /contains/],
    ["select attributes[model] from events", "wrong_arguments", /single quotes/],
    ["select count(sum(cost_usd)) from traces", "aggregate_misuse", /aggregate/],
  ];
  for (const [text, code, fix] of cases) {
    const result = compileRql(text, { now: NOW });
    assert.ok(!result.ok, text);
    assert.equal(result.error.code, code, text);
    assert.match(result.error.fix, fix, text);
  }
});
