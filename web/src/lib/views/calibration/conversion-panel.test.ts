import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExperimentConversionPanel } from "@/components/console/calibration/ExperimentConversionPanel";
import type { ExperimentArmConversionMetrics } from "@/lib/synthesis/experiments/types";

/**
 * The invocation histogram used to render as chips reading `Rank 1 · 4` — a
 * label, a separator and a number, with nothing to say whether four was most of
 * the invocations or almost none. These lock in the replacement: reader-facing
 * positions, a distinct label for "never surfaced", and a share per row.
 */

function conversion(
  overrides: Partial<ExperimentArmConversionMetrics> = {},
): ExperimentArmConversionMetrics {
  return {
    arm: "candidate",
    outcomeCount: 6,
    outcomesByLabel: { resolved: 4, escalated: 2 },
    unlabeledOutcomeCount: 0,
    averageOutcomeScore: 0.8,
    invocationCount: 10,
    servedInvocationCount: 8,
    notServedInvocationCount: 2,
    // Wire ranks are 0-based; -1 means the search never returned it.
    invocationRankHistogram: { "-1": 2, "0": 4, "1": 1, "2": 1, "3": 2 },
    averageInvocationAgeMs: 4200,
    ...overrides,
  };
}

function render(metrics: ExperimentArmConversionMetrics): string {
  return renderToStaticMarkup(
    createElement(ExperimentConversionPanel, {
      arms: [{ arm: metrics.arm, conversion: metrics }],
      summary: {
        invocationCount: 10,
        attributedInvocationCount: 10,
        unattributedInvocationCount: 0,
        invocationAttributionRate: 1,
        unresolvedOutcomeCount: 0,
      },
    }),
  );
}

test("wire ranks are shown as reader-facing positions", () => {
  const markup = render(conversion());

  // Rank 0 on the wire is the first result a reader sees.
  assert.match(markup, /Position 1/);
  assert.match(markup, /Position 4/);
  assert.doesNotMatch(
    markup,
    /Position 0/,
    "positions should count from one, not from the wire's zero",
  );
});

test("never-surfaced invocations are not labelled as a position", () => {
  const markup = render(conversion());

  assert.match(markup, /Not in results/);
  assert.doesNotMatch(
    markup,
    /Rank -1|Position 0/,
    "invoking something the search never returned is not a position",
  );
});

test("each row carries its share of the arm's invocations", () => {
  // 4 of 10 invocations landed at the top position.
  assert.match(render(conversion()), /40%/);
});
