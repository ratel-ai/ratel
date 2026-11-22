import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResilientReadDeps } from "@/lib/platform/resilient-read";
import { loadExperimentDetailSurface } from "@/lib/synthesis/experiments/surface-loaders";
import type { ExperimentComparison } from "@/lib/synthesis/experiments/types";

test("experiment detail surfaces primary comparison failures", async () => {
  const timeout = new Error("canceling statement due to statement timeout");

  await assert.rejects(
    loadExperimentDetailSurface(
      { distinctId: "project:p1" },
      {
        loadComparison: async () => {
          throw timeout;
        },
        loadLifecycle: async () => null,
        loadConversion: async () => null,
      },
    ),
    timeout,
  );
});

test("experiment detail hides failed lifecycle data without losing conversion data", async () => {
  const degradedOperations: string[] = [];
  const base = comparison();

  const result = await loadExperimentDetailSurface(
    { distinctId: "project:p1" },
    {
      loadComparison: async () => base,
      loadLifecycle: async () => {
        throw new Error("lifecycle timed out");
      },
      loadConversion: async () => ({
        arms: [],
        invocationCount: 4,
        attributedInvocationCount: 3,
        unattributedInvocationCount: 1,
        invocationAttributionRate: 0.75,
        unresolvedOutcomeCount: 2,
      }),
      resilientReadDeps: recordingResilientReadDeps(degradedOperations),
    },
  );

  assert.equal(result == null || "lifecycleDiagnostics" in result, false);
  assert.deepEqual(result?.conversionSummary, {
    invocationCount: 4,
    attributedInvocationCount: 3,
    unattributedInvocationCount: 1,
    invocationAttributionRate: 0.75,
    unresolvedOutcomeCount: 2,
  });
  assert.deepEqual(degradedOperations, ["experiment_lifecycle"]);
});

test("experiment detail hides failed conversion data without losing lifecycle data", async () => {
  const degradedOperations: string[] = [];
  const diagnostics = { hasLifecycleEvents: true, latestLogAt: null };

  const result = await loadExperimentDetailSurface(
    { distinctId: "project:p1" },
    {
      loadComparison: async () => comparison(),
      loadLifecycle: async () => ({ arms: [], diagnostics }),
      loadConversion: async () => {
        throw new Error("conversion timed out");
      },
      resilientReadDeps: recordingResilientReadDeps(degradedOperations),
    },
  );

  assert.deepEqual(result?.lifecycleDiagnostics, diagnostics);
  assert.equal(result == null || "conversionSummary" in result, false);
  assert.deepEqual(degradedOperations, ["experiment_conversion"]);
});

function comparison(): ExperimentComparison {
  return {
    name: "ranking",
    mode: "split",
    baselineArm: "control",
    arms: [],
    capabilities: { hasRankings: false, rows: [], reportedHitMetrics: [] },
    issues: [],
  };
}

function recordingResilientReadDeps(degradedOperations: string[]): ResilientReadDeps {
  return {
    logError: (_message, _error, fields) => degradedOperations.push(String(fields?.operation)),
    reportServerException: () => undefined,
  };
}
