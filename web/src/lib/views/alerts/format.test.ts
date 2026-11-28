import assert from "node:assert/strict";
import { test } from "node:test";
import { metricQuery } from "@/lib/contracts/query";
import { formOf } from "@/lib/views/dashboards/widget";
import {
  alertWindowText,
  conditionText,
  measuredText,
  thresholdFrom,
  thresholdInput,
} from "./format";
import { alertQueryOf, NEW_ALERT_PARAM, newAlertHref } from "./links";
import { alertFormQuery, parseAlertQuery } from "./parse-rule";

test("a condition reads as a sentence, in the metric's unit", () => {
  const query = alertFormQuery(formOf(metricQuery("latency", "p95")));
  assert.equal(
    conditionText({ query }, { operator: "above", threshold: 2000, windowMinutes: 60 }),
    "Latency p95 is above 2\u00a0s over 1 hour",
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
  const query = metricQuery("scorer_pass_rate", "rate", {
    filters: {
      models: ["a&b", "c"],
      scorer: { id: "44444444-4444-4444-8444-444444444444" },
    },
  });
  // An alert has no grouping and no bucket.
  const href = newAlertHref("p", { ...query, dimensions: ["model"], bucket: "day" });
  const value = new URL(href, "https://ratel.test").searchParams.get(NEW_ALERT_PARAM);
  const parsed = parseAlertQuery(alertQueryOf(value ?? ""));
  assert.deepEqual(parsed, { ok: true, query: alertFormQuery(formOf(query)) });
});

test("F446-1, F446-2: the form says what the window reads and what nothing is", () => {
  assert.match(alertWindowText("count"), /longer than the window counts too\. .* the value is 0\./);
  assert.match(alertWindowText("p95"), /longer than the window counts too\. .* has no data\./);
});
