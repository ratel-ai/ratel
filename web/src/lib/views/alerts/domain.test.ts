import assert from "node:assert/strict";
import { test } from "node:test";
import { metricQuery } from "@/lib/contracts/query";
import { breaches, evaluationIntervalMs, evaluationWindow, nextState } from "./domain";
import { parseAlertQuery, parseRule } from "./parse-rule";

const ABOVE = { operator: "above", threshold: 10 } as const;
const BELOW = { operator: "below", threshold: 10 } as const;
const OK = { state: "ok", firing: false } as const;
const ALERTING = { state: "alerting", firing: true } as const;
const at = (value: number) => ({ value });
const NO_ROWS = { value: null };

test("above and below are strict", () => {
  assert.deepEqual(
    [9, 10, 11].map((v) => breaches(v, ABOVE)),
    [false, false, true],
  );
  assert.deepEqual(
    [9, 10, 11].map((v) => breaches(v, BELOW)),
    [true, false, false],
  );
});

test("crossing fires once, coming back recovers once", () => {
  assert.deepEqual(nextState(OK, ABOVE, at(11)), {
    state: "alerting",
    firing: true,
    value: 11,
    changed: true,
    notice: "fire",
  });
  assert.deepEqual(nextState(ALERTING, ABOVE, at(9)), {
    state: "ok",
    firing: false,
    value: 9,
    changed: true,
    notice: "recovery",
  });
});

test("an unchanged state writes no history and says nothing", () => {
  for (const [current, value] of [
    [OK, 1],
    [ALERTING, 99],
  ] as const) {
    const next = nextState(current, ABOVE, at(value));
    assert.deepEqual([next.changed, next.notice], [false, null]);
  }
  const still = nextState({ state: "no_data", firing: false }, ABOVE, NO_ROWS);
  assert.deepEqual([still.changed, still.notice], [false, null]);
});

test("no value is no data, without a message; 0 is a value", () => {
  const none = nextState(OK, BELOW, NO_ROWS);
  assert.deepEqual(
    [none.state, none.value, none.changed, none.notice],
    ["no_data", null, true, null],
  );
  const zero = nextState(OK, BELOW, at(0));
  assert.deepEqual([zero.state, zero.value, zero.notice], ["alerting", 0, "fire"]);
});

test("an alert that loses its data neither fires twice nor loses its recovery", () => {
  const lost = nextState(ALERTING, ABOVE, NO_ROWS);
  assert.deepEqual([lost.state, lost.firing, lost.notice], ["no_data", true, null]);
  assert.equal(nextState(lost, ABOVE, at(11)).notice, null);
  assert.equal(nextState(lost, ABOVE, at(9)).notice, "recovery");
});

test("the window ends now; a day is read less often", () => {
  const now = new Date("2026-11-24T10:00:00Z");
  assert.equal(evaluationWindow(15, now).since.toISOString(), "2026-11-24T09:45:00.000Z");
  assert.ok(evaluationIntervalMs(5) < 60_000);
  assert.ok(evaluationIntervalMs(1440) > 60_000);
});

test("a rule from outside is checked like a widget", () => {
  const draft = {
    name: " Slow ",
    query: metricQuery("latency", "p95", { filters: { models: ["a"] } }),
    operator: "above",
    threshold: 1000,
    windowMinutes: 5,
    destinationIds: [],
  };
  const off = { customMonitoring: false };
  const parsed = parseRule(draft, off);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.draft, { ...draft, name: "Slow" });
  const refused: [Record<string, unknown>, RegExp][] = [
    [{ name: " " }, /name/],
    [{ name: "x".repeat(81) }, /80/],
    [{ operator: "equal" }, /invalid/],
    [{ threshold: -1 }, /threshold/],
    [{ threshold: Number.NaN }, /threshold/],
    [{ windowMinutes: 7 }, /invalid/],
    [{ query: { metric: "latency", aggregation: "p95", filter: {} } }, /Unknown query kind/],
    [{ query: metricQuery("nope" as never, "p95") }, /Unknown measure/],
    [{ query: metricQuery("latency", "sum") }, /aggregated/],
    [{ query: metricQuery("latency", "p95", { dimensions: ["model"] }) }, /cannot be grouped/],
    [{ query: metricQuery("scorer_pass_rate", "rate") }, /off for this project/],
  ];
  for (const [change, error] of refused) {
    const result = parseRule({ ...draft, ...change }, off);
    assert.ok(!result.ok);
    assert.match(result.error, error);
  }
});

test("an alert refuses a query of kind sql: it compares one number", () => {
  assert.deepEqual(
    parseAlertQuery(
      { version: 1, kind: "sql", text: "select count(*) from traces", rqlVersion: 1 },
      { customMonitoring: true },
    ),
    {
      ok: false,
      error: "An alert compares one number: a sql has none.",
    },
  );
});
