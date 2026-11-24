import assert from "node:assert/strict";
import { test } from "node:test";
import { conditionText, measuredText, thresholdFrom, thresholdInput } from "./format";
import { NEW_ALERT_PARAM, newAlertHref } from "./links";
import { parseQuery } from "./parse-rule";

test("a condition reads as a sentence, in the metric's unit", () => {
  const query = { metric: "latency", aggregation: "p95", filter: {} } as const;
  assert.equal(
    conditionText({ query }, { operator: "above", threshold: 2000, windowMinutes: 60 }),
    "Latency p95 is above 2 s over 1 hour",
  );
  assert.equal(measuredText(0.5004, "ratio"), "50%");
  assert.equal(measuredText(0.667, "ratio"), "66.7%");
});

test("a ratio is typed as a percentage and stored as a share", () => {
  assert.equal(thresholdFrom("7", "ratio"), 0.07);
  assert.equal(thresholdInput(0.07, "ratio"), "7");
  assert.equal(thresholdFrom("1500", "ms"), 1500);
  for (const refused of ["", " ", "-1", "x", "Infinity"])
    assert.equal(thresholdFrom(refused, "ms"), null);
});

test("a widget's query survives the link to the form", () => {
  const query = {
    metric: "scorer_pass_rate",
    aggregation: "rate",
    filter: { models: ["a&b", "c"] },
    scorerId: "44444444-4444-4444-8444-444444444444",
  } as const;
  const href = newAlertHref("p", { ...query, filter: { models: [...query.filter.models] } });
  const value = new URL(href, "https://ratel.test").searchParams.get(NEW_ALERT_PARAM);
  const parsed = parseQuery(JSON.parse(value ?? ""), { scorers: true });
  assert.deepEqual(parsed, { ok: true, query });
});
