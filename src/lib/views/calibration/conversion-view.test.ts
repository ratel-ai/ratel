import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExperimentConversionPanel } from "@/components/console/calibration/ExperimentConversionPanel";

test("ExperimentConversionPanel renders outcome and invocation metrics with explicit unknown buckets", () => {
  const html = renderToStaticMarkup(
    createElement(ExperimentConversionPanel, {
      arms: [
        {
          arm: "control",
          conversion: {
            arm: "control",
            outcomeCount: 3,
            outcomesByLabel: { accepted: 2 },
            unlabeledOutcomeCount: 1,
            averageOutcomeScore: 0.766,
            invocationCount: 3,
            servedInvocationCount: 2,
            notServedInvocationCount: 1,
            invocationRankHistogram: { "-1": 1, "0": 1, "1": 1 },
            averageInvocationAgeMs: 400,
          },
        },
        { arm: "candidate", conversion: null },
      ],
      summary: {
        invocationCount: 4,
        attributedInvocationCount: 3,
        unattributedInvocationCount: 1,
        invocationAttributionRate: 0.75,
        unresolvedOutcomeCount: 2,
      },
    }),
  );

  for (const text of [
    "Outcomes &amp; invocations",
    "Overall attribution",
    "75%",
    "Unattributed invocations",
    "Unresolved outcomes",
    "control",
    "Average score",
    "0.77",
    "accepted",
    "Unlabeled",
    "Average age",
    "400 ms",
    // Wire ranks are 0-based; the panel counts positions from one and gives
    // "never surfaced" its own label rather than a position.
    "Position 1",
    "Position 2",
    "Not in results",
    "candidate",
    "No outcomes reported",
    "No invocations reported",
  ]) {
    assert.match(html, new RegExp(text));
  }
});
