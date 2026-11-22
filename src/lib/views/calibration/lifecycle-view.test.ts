import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExperimentLifecyclePanels } from "@/components/console/calibration/ExperimentLifecyclePanels";
import type { ExperimentLifecycleArmMetrics } from "@/lib/synthesis/experiments/types";

test("ExperimentLifecyclePanels renders agreement and reliability per shadow arm", () => {
  const html = renderToStaticMarkup(
    createElement(ExperimentLifecyclePanels, {
      metrics: [lifecycleMetrics()],
      diagnostics: {
        hasLifecycleEvents: true,
        latestLogAt: new Date("2026-07-20T12:00:00.000Z"),
      },
    }),
  );

  for (const text of [
    "Agreement",
    "candidate",
    "shadow",
    "Top-1",
    "50%",
    "Exact order",
    "75%",
    "Jaccard@5",
    "0.63",
    "8 comparisons",
    "Reliability",
    "Shadow coverage",
    "80%",
    "Skips",
    "Fallbacks",
    "Drops",
    "timeout",
  ]) {
    assert.match(html, new RegExp(text));
  }
});

test("ExperimentLifecyclePanels distinguishes missing ingestion from genuine zero metrics", () => {
  const missing = renderToStaticMarkup(
    createElement(ExperimentLifecyclePanels, {
      metrics: [],
      diagnostics: { hasLifecycleEvents: false, latestLogAt: null },
    }),
  );
  assert.match(missing, /No lifecycle events received in this window/);
  assert.match(missing, /SDK ≥ ratel-ai\/ratel#140/);

  const zero = renderToStaticMarkup(
    createElement(ExperimentLifecyclePanels, {
      metrics: [],
      diagnostics: {
        hasLifecycleEvents: true,
        latestLogAt: new Date("2026-07-20T12:00:00.000Z"),
      },
    }),
  );
  assert.match(zero, /Lifecycle events are arriving/);
  assert.match(zero, /No shadow metrics for this experiment/);
  assert.doesNotMatch(zero, /No lifecycle events received in this window/);
});

function lifecycleMetrics(): ExperimentLifecycleArmMetrics {
  return {
    arm: "candidate",
    role: "shadow",
    comparisonCount: 8,
    top1Rate: 0.5,
    exactOrderRate: 0.75,
    averageJaccardAtK: 0.625,
    agreementK: 5,
    skipCount: 2,
    fallbackCount: 1,
    dropCount: 1,
    dropsByReason: { timeout: 1 },
    shadowCoverage: 0.8,
  };
}
