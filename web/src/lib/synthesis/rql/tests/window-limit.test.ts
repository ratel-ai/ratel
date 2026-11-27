import assert from "node:assert/strict";
import { test } from "node:test";
import { compileRql, RQL_LIMITS } from "../compile";

const NOW = new Date("2026-11-25T12:00:00.000Z");
const WINDOW = `"started_at" >= $1::timestamptz and "started_at" < $2::timestamptz`;

test("the default window is the last defaultWindowHours before now", () => {
  const result = compileRql("select trace_id from traces", { now: NOW });
  assert.ok(result.ok);
  const hours = (Date.parse(result.window.to) - Date.parse(result.window.from)) / 3_600_000;
  assert.equal(hours, RQL_LIMITS.defaultWindowHours);
  assert.equal(result.window.to, NOW.toISOString());
  assert.deepEqual(result.params.slice(0, 2), [result.window.from, result.window.to]);
});

test("a window the caller gives is $1 and $2", () => {
  const window = { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-08T00:00:00Z") };
  const result = compileRql("select trace_id from traces", { now: NOW, window });
  assert.ok(result.ok);
  assert.deepEqual(result.window, {
    from: "2026-11-01T00:00:00.000Z",
    to: "2026-11-08T00:00:00.000Z",
  });
  assert.deepEqual(result.params, ["2026-11-01T00:00:00.000Z", "2026-11-08T00:00:00.000Z", 100]);
});

test("a window of exactly maxWindowDays is accepted, a longer one is refused", () => {
  const from = new Date("2026-10-01T00:00:00Z");
  const max = new Date(from.getTime() + RQL_LIMITS.maxWindowDays * 86_400_000);
  assert.ok(compileRql("select trace_id from traces", { now: NOW, window: { from, to: max } }).ok);
  const longer = compileRql("select trace_id from traces", {
    now: NOW,
    window: { from, to: new Date(max.getTime() + 1) },
  });
  assert.equal(longer.ok, false);
  assert.ok(!longer.ok && longer.error.code === "invalid_window");
  assert.ok(!longer.ok && longer.error.fix.includes(`${RQL_LIMITS.maxWindowDays} days`));
});

test("a reversed, empty or invalid window is refused", () => {
  const at = new Date("2026-11-01T00:00:00Z");
  for (const window of [
    { from: at, to: at },
    { from: new Date("2026-11-02T00:00:00Z"), to: at },
    { from: new Date("not a date"), to: at },
  ]) {
    const result = compileRql("select trace_id from traces", { now: NOW, window });
    assert.ok(!result.ok && result.error.code === "invalid_window");
  }
});

test("a time filter in WHERE narrows inside the window, and never widens it", () => {
  const result = compileRql("select trace_id from traces where started_at >= '2020-01-01'", {
    now: NOW,
  });
  assert.ok(result.ok);
  assert.equal(
    result.sql,
    `select "trace_id" as "c1" from "rql"."traces" where ${WINDOW} and ("started_at" >= $3::timestamptz) limit $4::bigint`,
  );
});

test("a query without LIMIT gets defaultLimit", () => {
  const result = compileRql("select trace_id from traces", { now: NOW });
  assert.ok(result.ok);
  assert.equal(result.limit, RQL_LIMITS.defaultLimit);
  assert.equal(result.params[result.limitParam], RQL_LIMITS.defaultLimit);
});

test("the LIMIT is its own parameter, never shared with a literal of equal value", () => {
  const result = compileRql(
    "select trace_id from traces where duration_ms = 100 and input_tokens = 7 limit 100",
    { now: NOW },
  );
  assert.ok(result.ok);
  assert.match(result.sql, /"duration_ms" = \$3::/);
  assert.match(result.sql, / limit \$5::bigint$/);
  assert.equal(result.limitParam, 4);
  assert.deepEqual(result.params.slice(2), [100, 7, 100]);
});

test("a LIMIT above maxLimit is lowered to maxLimit", () => {
  const result = compileRql(`select trace_id from traces limit ${RQL_LIMITS.maxLimit + 1}`, {
    now: NOW,
  });
  assert.ok(result.ok);
  assert.equal(result.limit, RQL_LIMITS.maxLimit);
  assert.match(result.sql, / limit \$3::bigint$/);
  assert.equal(result.params[result.limitParam], RQL_LIMITS.maxLimit);
});

test("a LIMIT that is not a whole number of rows is refused", () => {
  for (const limit of ["-1", "2.5", "'10'", "all_rows", "1 + 1"]) {
    const result = compileRql(`select trace_id from traces limit ${limit}`, { now: NOW });
    assert.ok(!result.ok, limit);
    assert.ok(
      ["invalid_limit", "syntax_error"].includes(result.error.code),
      `${limit}: ${result.error.code}`,
    );
  }
});

test("sessions group the traces of the window by session, before the outer filter", () => {
  const result = compileRql(
    "select session_id, trace_count from sessions where cost_usd > 1 order by trace_count desc limit 10",
    { now: NOW },
  );
  assert.ok(result.ok);
  assert.equal(
    result.sql,
    `select "session_id" as "c1", "trace_count" as "c2" from (select "session_id" as "session_id", max("user_id") as "user_id", count(*) as "trace_count", count(*) filter (where "has_error") as "error_count", min("started_at") as "first_trace_at", max("started_at") as "last_trace_at", sum("duration_ms") as "total_duration_ms", sum("input_tokens") as "input_tokens", sum("output_tokens") as "output_tokens", sum("cost_usd") as "cost_usd" from "rql"."sessions" where ${WINDOW} group by "session_id") as "sessions" where ("cost_usd" > $3::bigint) order by "trace_count" desc limit $4::bigint`,
  );
  assert.equal(result.table, "sessions");
});

test("users group the traces of the window by end user, and aggregate over the users", () => {
  const result = compileRql("select count(*), avg(session_count) from users", { now: NOW });
  assert.ok(result.ok);
  assert.equal(
    result.sql,
    `select count(*) as "c1", avg("session_count") as "c2" from (select "user_id" as "user_id", count(distinct "session_id") as "session_count", count(*) as "trace_count", count(*) filter (where "has_error") as "error_count", min("started_at") as "first_trace_at", max("started_at") as "last_trace_at", sum("duration_ms") as "total_duration_ms", sum("input_tokens") as "input_tokens", sum("output_tokens") as "output_tokens", sum("cost_usd") as "cost_usd" from "rql"."users" where ${WINDOW} group by "user_id") as "users" limit $3::bigint`,
  );
});
