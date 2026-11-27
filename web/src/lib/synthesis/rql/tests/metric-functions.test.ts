import assert from "node:assert/strict";
import { test } from "node:test";
import { compileRql, RQL_LIMITS } from "../compile";

/**
 * What RQL needs to express each metric of the form: `rate`, `coalesce`, `each`, the `prompts`
 * table, a window by known time, and the long window of a console run.
 */

const NOW = new Date("2026-11-25T12:00:00.000Z");
const FROM = "2026-11-24T12:00:00.000Z";
const TO = "2026-11-25T12:00:00.000Z";
const DAY_MS = 86_400_000;

function compiled(text: string, options: Partial<Parameters<typeof compileRql>[1]> = {}) {
  const result = compileRql(text, { now: NOW, ...options });
  if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
  return result;
}

test("rate(condition) is the share of rows where it is true, a null counting as not true", () => {
  const result = compiled("select rate(coalesce(root_error, has_error)) as failed from traces");
  assert.equal(
    result.sql,
    `select avg(case when coalesce("root_error", "has_error") then 1.0 else 0.0 end) as "c1" from "rql"."traces" where "started_at" >= $1::timestamptz and "started_at" < $2::timestamptz limit $3::bigint`,
  );
  assert.deepEqual(result.params, [FROM, TO, 100]);
  assert.deepEqual(result.columns, [{ name: "failed", type: "number" }]);
  assert.equal(result.oneRow, true);
});

test("rate takes one condition, never a number or an aggregate", () => {
  for (const [text, code] of [
    ["select rate(duration_ms) from traces", "type_mismatch"],
    ["select rate(has_error, root_error) from traces", "wrong_arguments"],
    ["select rate(count(*) > 1) from traces", "aggregate_misuse"],
    ["select trace_id from traces where rate(has_error) > 0", "aggregate_misuse"],
  ] as const) {
    const result = compileRql(text, { now: NOW });
    assert.ok(!result.ok && result.error.code === code, `${text}: ${JSON.stringify(result)}`);
  }
});

test("coalesce gives the first value that is not null, with the type of its values", () => {
  const result = compiled(
    "select coalesce(sum(cost_usd), 0) as cost, coalesce(sum(input_tokens), 0) as tokens, coalesce(service_name, 'none') as service from traces group by service",
  );
  assert.match(
    result.sql,
    /^select coalesce\(sum\("cost_usd"\), \$3::bigint\) as "c1", coalesce\(sum\("input_tokens"\), \$3::bigint\) as "c2", coalesce\("service_name", \$4::text\) as "c3" from "rql"\."traces" where .* group by "c3" limit \$5::bigint$/,
  );
  assert.deepEqual(result.params, [FROM, TO, 0, "none", 100]);
  assert.deepEqual(
    result.columns.map(({ type }) => type),
    ["number", "integer", "text"],
  );
});

test("coalesce reads a text literal as a timestamp next to a timestamp", () => {
  const result = compiled("select coalesce(scored_at, '2026-11-01') from scores");
  assert.deepEqual(result.params.slice(2, 3), ["2026-11-01T00:00:00.000Z"]);
  assert.equal(result.columns[0].type, "timestamp");
});

test("coalesce refuses one argument, and values of two types", () => {
  for (const [text, code] of [
    ["select coalesce(cost_usd) from traces", "wrong_arguments"],
    ["select coalesce(cost_usd, 'x') from traces", "type_mismatch"],
    ["select coalesce(models, tools) from traces", "type_mismatch"],
  ] as const) {
    const result = compileRql(text, { now: NOW });
    assert.ok(!result.ok && result.error.code === code, `${text}: ${JSON.stringify(result)}`);
  }
});

test("each(list) reads a row once per distinct value of the list, one join per list", () => {
  const result = compiled(
    "select each(models) as model, each(tools) as tool, count(*) from traces where each(models) != 'x' group by model, tool",
  );
  assert.equal(
    result.sql,
    `select "each_models"."v" as "c1", "each_tools"."v" as "c2", count(*) as "c3" from "rql"."traces" cross join lateral (select distinct "v" from unnest("models") as "u"("v")) as "each_models" cross join lateral (select distinct "v" from unnest("tools") as "u"("v")) as "each_tools" where "started_at" >= $1::timestamptz and "started_at" < $2::timestamptz and ("each_models"."v" <> $3::text) group by "c1", "c2" limit $4::bigint`,
  );
  assert.deepEqual(result.params, [FROM, TO, "x", 100]);
  assert.deepEqual(result.columns, [
    { name: "model", type: "text" },
    { name: "tool", type: "text" },
    { name: "count", type: "integer" },
  ]);
});

test("under a page filter of the list, each gives only the values the filter keeps", () => {
  const result = compiled("select each(models) as model, count(*) from scores group by model", {
    filter: { models: ["a", "b"], and: [{ models: ["b"] }, { tools: ["t"] }] },
  });
  assert.match(
    result.sql,
    /and "each_models"\."v" in \(\$3::text, \$4::text\) and "each_models"\."v" in \(\$4::text\) group by/,
  );
  assert.deepEqual(result.params.slice(2, 5), ["a", "b", "t"]);
});

test("each needs a list column, and its value grouped or aggregated", () => {
  for (const [text, code] of [
    ["select each(service_name) from traces", "type_mismatch"],
    ["select each('a') from traces", "wrong_arguments"],
    ["select each(models), count(*) from traces", "ungrouped_column"],
    ["select each(models) from sessions", "unknown_column"],
  ] as const) {
    const result = compileRql(text, { now: NOW });
    assert.ok(!result.ok && result.error.code === code, `${text}: ${JSON.stringify(result)}`);
  }
});

test("the prompts table reads the captured prompts, and the page filter keeps all of them", () => {
  const result = compiled(
    "select time_bucket('1 day', occurred_at) as day, coalesce(sum(context_tokens), 0) from prompts group by day",
    { filter: { models: ["a"] } },
  );
  assert.equal(
    result.sql,
    `select date_bin($3::interval, "occurred_at", timestamptz '2000-01-03 00:00:00+00') as "c1", coalesce(sum("context_tokens"), $4::bigint) as "c2" from "rql"."prompts" where "occurred_at" >= $1::timestamptz and "occurred_at" < $2::timestamptz group by "c1" limit $5::bigint`,
  );
  assert.deepEqual(result.params, [FROM, TO, "1 day", 0, 100]);
});

test("a window by known time applies to known_at of traces and scored_at of scores", () => {
  const window = { from: new Date(FROM), to: new Date(TO), by: "known" as const };
  for (const [table, column] of [
    ["traces", "known_at"],
    ["scores", "scored_at"],
    ["events", "started_at"],
    ["prompts", "occurred_at"],
  ]) {
    const result = compiled(`select count(*) from ${table}`, { window });
    assert.match(
      result.sql,
      new RegExp(`where "${column}" >= \\$1::timestamptz and "${column}" < \\$2::timestamptz`),
    );
  }
});

test("a console run reads up to consoleMaxWindowDays, an agent's run up to maxWindowDays", () => {
  const window = (days: number) => ({ from: new Date(NOW.getTime() - days * DAY_MS), to: NOW });
  const long = window(RQL_LIMITS.consoleMaxWindowDays);
  assert.equal(RQL_LIMITS.consoleMaxWindowDays, 372);
  assert.ok(
    compileRql("select count(*) from traces", { now: NOW, window: long, console: true }).ok,
  );
  const tooLong = compileRql("select count(*) from traces", {
    now: NOW,
    window: window(RQL_LIMITS.consoleMaxWindowDays + 1),
    console: true,
  });
  assert.ok(!tooLong.ok && tooLong.error.code === "invalid_window");
  const agent = compileRql("select count(*) from traces", {
    now: NOW,
    window: window(RQL_LIMITS.maxWindowDays + 1),
  });
  assert.ok(!agent.ok && agent.error.code === "invalid_window");
  assert.match(agent.ok ? "" : agent.error.message, /30 days/);
});
