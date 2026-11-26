import assert from "node:assert/strict";
import { test } from "node:test";
import { compileRql, RQL_LIMITS } from "../compile";
import { compileQuery } from "../domain/compile";

/** The small findings of the review of the RQL core: each one a refusal or a fixed answer. */

const NOW = new Date("2026-11-25T12:00:00.000Z");

function refused(text: string) {
  const result = compileRql(text, { now: NOW });
  assert.ok(!result.ok, `${text.slice(0, 80)} compiled`);
  return result.error;
}

test("an expression deeper than maxExpressionDepth is a syntax_error, not a thrown RangeError", () => {
  const nots = `select count(*) from traces where ${"not ".repeat(900)}true`;
  assert.equal(refused(nots).code, "syntax_error");
  const ors = `select count(*) from traces where true${" or true".repeat(400)}`;
  assert.equal(refused(ors).code, "syntax_error");
  const parens = `select count(*) from traces where ${"(".repeat(RQL_LIMITS.maxExpressionDepth + 1)}true${")".repeat(RQL_LIMITS.maxExpressionDepth + 1)}`;
  const error = refused(parens);
  assert.equal(error.code, "syntax_error");
  assert.match(error.message, new RegExp(`${RQL_LIMITS.maxExpressionDepth}`));
  assert.ok(
    compileRql(`select count(*) from traces where ${"not ".repeat(20)}true`, { now: NOW }).ok,
  );
});

test("a function named as an Object property gets a text fix, not a function", () => {
  for (const name of ["constructor", "__proto__", "tostring", "hasOwnProperty", "valueOf"]) {
    const error = refused(`select ${name}(duration_ms) from traces`);
    assert.equal(error.code, "unknown_function");
    assert.equal(typeof error.fix, "string", name);
    assert.doesNotMatch(error.fix, /native code/, name);
  }
});

test("a week of time_bucket starts on Monday", () => {
  const result = compileRql(
    "select time_bucket('1 week', started_at) as week, count(*) from traces group by week",
    { now: NOW },
  );
  assert.ok(result.ok);
  const origin = /timestamptz '([^']+)'/.exec(result.sql)?.[1];
  assert.ok(origin);
  assert.equal(new Date(origin.replace(" ", "T").replace("+00", "Z")).getUTCDay(), 1);
});

test("a timestamp that does not exist on the calendar is refused, not moved", () => {
  for (const text of [
    "2026-02-30",
    "2026-11-31",
    "2026-13-01",
    "2026-11-26T24:00:00Z",
    "2026-11-26T10:60:00Z",
  ]) {
    const error = refused(`select trace_id from traces where started_at > '${text}'`);
    assert.equal(error.code, "invalid_literal", text);
  }
  assert.ok(
    compileRql("select trace_id from traces where started_at > '2028-02-29'", { now: NOW }).ok,
  );
});

test("an aggregate over an alias of an aggregate is refused", () => {
  const error = refused(
    "select service_name, count(*) as n from traces group by service_name having sum(n) > 1",
  );
  assert.equal(error.code, "aggregate_misuse");
  assert.ok(
    compileRql(
      "select service_name, count(*) as n from traces group by service_name having n > 1",
      {
        now: NOW,
      },
    ).ok,
  );
});

test("each output column has a name no other column has", () => {
  const result = compileRql("select trace_id a, trace_id a, trace_id a_2 from traces", {
    now: NOW,
  });
  assert.ok(result.ok);
  const names = result.columns.map(({ name }) => name);
  assert.equal(new Set(names).size, names.length, names.join(", "));
  assert.deepEqual(names.slice(0, 1), ["a"]);
  assert.equal(names[2], "a_2", "a name the query gives is kept");
});

test("a RangeError that is not a stack overflow is not hidden as a syntax_error", () => {
  const throwing = () => {
    throw new RangeError("Invalid time value");
  };
  assert.throws(
    () => compileQuery("select trace_id from traces", throwing, { now: NOW }),
    /Invalid time value/,
  );
});
