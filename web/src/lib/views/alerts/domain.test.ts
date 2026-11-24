import assert from "node:assert/strict";
import { test } from "node:test";
import { breaches, evaluationIntervalMs, evaluationWindow, nextState } from "./domain";
import { parseRule } from "./parse-rule";

const ABOVE = { operator: "above", threshold: 10 } as const;
const BELOW = { operator: "below", threshold: 10 } as const;
const OK = { state: "ok", firing: false } as const;
const ALERTING = { state: "alerting", firing: true } as const;
const at = (value: number) => ({ value, samples: 3 });

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
  const still = nextState({ state: "no_data", firing: false }, ABOVE, null);
  assert.deepEqual([still.changed, still.notice], [false, null]);
});

test("no rows, no value or no metric is no data, without a message", () => {
  for (const measured of [{ value: 0, samples: 0 }, { value: null, samples: 2 }, null]) {
    const next = nextState(OK, BELOW, measured);
    assert.deepEqual(
      [next.state, next.value, next.changed, next.notice],
      ["no_data", null, true, null],
    );
  }
});

test("an alert that loses its data neither fires twice nor loses its recovery", () => {
  const lost = nextState(ALERTING, ABOVE, null);
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
    query: { metric: "latency", aggregation: "p95", filter: { models: ["a"] } },
    operator: "above",
    threshold: 1000,
    windowMinutes: 5,
    destinationIds: [],
  };
  const off = { scorers: false };
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
    [{ query: { metric: "nope", aggregation: "p95" } }, /Unknown metric/],
    [{ query: { metric: "latency", aggregation: "sum" } }, /aggregated/],
    [{ query: { metric: "latency", aggregation: "p95", groupBy: "model" } }, /invalid/],
    [{ query: { metric: "scorer_pass_rate", aggregation: "rate" } }, /off for this project/],
  ];
  for (const [change, error] of refused) {
    const result = parseRule({ ...draft, ...change }, off);
    assert.ok(!result.ok);
    assert.match(result.error, error);
  }
});
