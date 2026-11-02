import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import { type CalibrationOperationDeps, calibrationOperations } from "./calibration";

/**
 * Calibration over MCP.
 *
 * A comparison row carries two ranked result lists and both of their score
 * vectors. Handed over whole, a page of fifty is tens of thousands of tokens of
 * floats to answer "which queries went wrong", and the floats are the part the
 * agent can do least with: the diff summary already says how far apart the two
 * rankings are, and the ids say what actually swapped. These tests pin that
 * shaping, and pin that an experiment with no records reads as absent rather
 * than as an empty success.
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

function experiment(name: string) {
  return {
    name,
    mode: "shadow",
    baselineArm: "control",
    traceCount: 10,
    multiArmTraceCount: 10,
    arms: [],
    firstSeenAt: new Date("2026-08-01T00:00:00.000Z"),
    lastSeenAt: new Date("2026-08-20T00:00:00.000Z"),
  };
}

function comparisonRow() {
  return {
    selectionId: "sel-1",
    occurredAt: new Date("2026-08-20T10:00:00.000Z"),
    traceId: "trace-1",
    query: "how do I get a refund",
    servedArm: "control",
    shadowArm: "candidate",
    servedOutcome: "ok",
    shadowOutcome: "ok",
    servedDurationMs: 40,
    shadowDurationMs: 55,
    top1: false,
    exactOrder: false,
    agreementK: 5,
    matchScore: 0.6,
    servedResultIds: Array.from({ length: 30 }, (_, index) => `served-${index}`),
    shadowResultIds: Array.from({ length: 30 }, (_, index) => `shadow-${index}`),
    servedResultScores: Array.from({ length: 30 }, () => 0.123456789),
    shadowResultScores: Array.from({ length: 30 }, () => 0.987654321),
    diffSummary: { stable: 2, moved: 3, added: 1, dropped: 1 },
  };
}

function deps(overrides: Partial<CalibrationOperationDeps> = {}): CalibrationOperationDeps {
  return {
    listExperiments: (async () => [
      experiment("quiet-experiment"),
      experiment("noisy-experiment"),
    ]) as unknown as CalibrationOperationDeps["listExperiments"],
    resolveCalibrationSummaries: (async () =>
      new Map([
        ["quiet-experiment", { kind: "ranking-shadow", comparisonCount: 100, mismatchCount: 2 }],
        ["noisy-experiment", { kind: "ranking-shadow", comparisonCount: 80, mismatchCount: 40 }],
      ])) as unknown as CalibrationOperationDeps["resolveCalibrationSummaries"],
    getRankingCalibration: (async () => ({
      name: "noisy-experiment",
      kind: "ranking-shadow",
      pairs: [
        {
          servedArm: "control",
          shadowArm: "candidate",
          comparisonCount: 80,
          mismatchCount: 40,
          top1Rate: 0.512345,
          exactOrderRate: 0.25,
          averageJaccardAtK: 0.6789,
          jaccardByK: [],
          served: {},
          shadow: {},
        },
      ],
      arms: [
        { arm: "control", servingCount: 80, shadowingCount: 0, servingRate: 1, shadowingRate: 0 },
      ],
      lifecycle: [],
      comparisons: [comparisonRow()],
      totalComparisonCount: 80,
      mismatchCount: 40,
      filteredComparisonCount: 40,
    })) as unknown as CalibrationOperationDeps["getRankingCalibration"],
    listComparisonPage: (async () => ({
      rows: [comparisonRow()],
      total: 40,
    })) as unknown as CalibrationOperationDeps["listComparisonPage"],
    ...overrides,
  };
}

function run(
  operationId: string,
  params: Record<string, unknown>,
  overrides: Partial<CalibrationOperationDeps> = {},
) {
  return dispatchOperation(operationId, params, {
    registry: buildRegistry(calibrationOperations(deps(overrides))),
    auth,
  });
}

test("the experiment with the most disagreement is listed first", async () => {
  const result = await run("list_calibrations", {});

  const rows = (result as { data: { calibrations: Array<{ name: string; mismatchRate: number }> } })
    .data.calibrations;
  assert.equal(rows[0].name, "noisy-experiment", "the row worth opening should be the first one");
  assert.equal(rows[0].mismatchRate, 0.5);
  assert.equal(rows[1].mismatchRate, 0.02);
});

test("a window with no experiments says how to widen it, rather than just being empty", async () => {
  const result = await run(
    "list_calibrations",
    {},
    {
      listExperiments: (async () => []) as unknown as CalibrationOperationDeps["listExperiments"],
    },
  );

  assert.equal(result.ok, true);
  // An empty list and a misconfigured SDK look identical to an agent, and it
  // will report "your catalog is fine" for both unless told otherwise.
  assert.match(result.ok ? (result.hint ?? "") : "", /Widen the window|exporting/);
});

test("comparison rows carry the two rankings and drop the score vectors", async () => {
  const result = await run("list_calibration_mismatches", { experimentName: "noisy-experiment" });

  const [row] = (result as { data: { comparisons: Array<Record<string, unknown>> } }).data
    .comparisons;
  assert.equal(
    row.servedResultScores,
    undefined,
    "a float per position answers nothing on its own",
  );
  assert.equal(row.shadowResultScores, undefined);
  assert.deepEqual(row.diff, { stable: 2, moved: 3, added: 1, dropped: 1 });
  assert.equal((row.servedResultIds as string[]).length, 10, "ranked ids are capped");
  assert.equal((row.shadowResultIds as string[]).length, 10);
});

test("a mismatch row says how much slower the shadow arm was", async () => {
  const result = await run("list_calibration_mismatches", { experimentName: "noisy-experiment" });

  const [row] = (result as { data: { comparisons: Array<Record<string, unknown>> } }).data
    .comparisons;
  assert.equal(row.latencyDeltaMs, 15);
});

/**
 * The default that makes this operation worth having. "Show me the mismatches"
 * is the question; browsing every comparison is the exception.
 */
test("mismatches are the default selection, and agreements are opt-in", async () => {
  const seen: Array<{ scope: string }> = [];
  const capture = {
    listComparisonPage: (async (
      _projectId: string,
      _name: string,
      _window: unknown,
      options: { selection?: { scope: string } },
    ) => {
      seen.push({ scope: options.selection?.scope ?? "none" });
      return { rows: [], total: 0 };
    }) as unknown as CalibrationOperationDeps["listComparisonPage"],
  };

  await run("list_calibration_mismatches", { experimentName: "e" }, capture);
  await run(
    "list_calibration_mismatches",
    { experimentName: "e", includeAgreements: true },
    capture,
  );

  assert.deepEqual(seen, [{ scope: "mismatch" }, { scope: "all" }]);
});

test("an experiment with no comparison records is not found, not an empty success", async () => {
  const result = await run(
    "get_calibration",
    { experimentName: "never-ran" },
    {
      getRankingCalibration: (async () =>
        null) as unknown as CalibrationOperationDeps["getRankingCalibration"],
    },
  );

  assert.equal(result.ok === false && result.error, "not_found");
});

test("calibration detail points at the next step rather than stopping at numbers", async () => {
  const result = await run("get_calibration", { experimentName: "noisy-experiment" });

  assert.equal(result.ok, true);
  const data = (
    result as { data: { mismatchRate: number; armPairs: Array<Record<string, unknown>> } }
  ).data;
  assert.equal(data.mismatchRate, 0.5);
  assert.equal(data.armPairs[0].top1Rate, 0.5123, "rates are rounded, not carried to nine places");
  assert.match(
    result.ok ? (result.hint ?? "") : "",
    /test_retrieval/,
    "a mismatch the agent cannot act on is just a statistic",
  );
});

test("every calibration read answers, with no flag to switch it on", async () => {
  for (const [id, params] of [
    ["list_calibrations", {}],
    ["get_calibration", { experimentName: "e" }],
    ["list_calibration_mismatches", { experimentName: "e" }],
  ] as const) {
    const result = await run(id, params);
    assert.equal(result.ok, true, `${id} must answer without any flag set`);
  }
});
