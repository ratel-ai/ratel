import assert from "node:assert/strict";
import { test } from "node:test";
import { compareCapabilities } from "./capabilities";
import { compareArmMetrics } from "./compare";
import { detectExperimentIssues, ISSUE_THRESHOLDS } from "./issues";
import type {
  ArmMetricDeltas,
  CapabilityComparison,
  CapabilityComparisonSet,
  ComparedArm,
  ExperimentIssue,
  ExperimentIssueKind,
} from "./types";

const NO_CAPABILITIES: CapabilityComparisonSet = {
  hasRankings: false,
  rows: [],
  reportedHitMetrics: [],
};

const ZERO_DELTAS: ArmMetricDeltas = {
  errorRate: { absolute: 0, relative: null },
  averageLatencyMs: { absolute: 0, relative: 0 },
  p95LatencyMs: { absolute: 0, relative: 0 },
  averageInputTokens: { absolute: 0, relative: 0 },
  averageOutputTokens: { absolute: 0, relative: 0 },
  averageCostUsd: { absolute: 0, relative: 0 },
  averageSearchHitCount: { absolute: 0, relative: 0 },
};

test("issue thresholds use the conservative experiment defaults", () => {
  assert.deepEqual(ISSUE_THRESHOLDS, {
    minimumSampleSize: 20,
    capabilityAbsentMinAppearances: 3,
    rankingDivergence: 3,
    armImbalanceMinRatio: 0.5,
    errorRateDelta: 0.05,
    latencyRelativeDelta: 0.25,
  });
});

test("a missing-arm error appears only when fewer than two arms are observed", () => {
  const baseline = arm("control", 20, null);

  const oneArm = ofKind(detectExperimentIssues(baseline, [], NO_CAPABILITIES), "missing_arm");
  const twoArms = ofKind(
    detectExperimentIssues(baseline, [arm("treatment")], NO_CAPABILITIES),
    "missing_arm",
  );

  assert.deepEqual(
    {
      oneArm: oneArm.map(({ kind, severity, arm: issueArm, observedArms }) => ({
        kind,
        severity,
        arm: issueArm,
        observedArms,
      })),
      twoArms,
    },
    {
      oneArm: [
        {
          kind: "missing_arm",
          severity: "error",
          arm: null,
          observedArms: ["control"],
        },
      ],
      twoArms: [],
    },
  );
});

test("low-sample info fires per arm below 20, but not at 20", () => {
  const issues = detectExperimentIssues(
    arm("control", 19, null),
    [arm("small-treatment", 19), arm("threshold-treatment", 20)],
    NO_CAPABILITIES,
  );

  assert.deepEqual(
    ofKind(issues, "low_sample").map(({ kind, severity, arm: issueArm, traceCount }) => ({
      kind,
      severity,
      arm: issueArm,
      traceCount,
    })),
    [
      { kind: "low_sample", severity: "info", arm: "control", traceCount: 19 },
      { kind: "low_sample", severity: "info", arm: "small-treatment", traceCount: 19 },
    ],
  );
});

test("arm-imbalance info fires when the smallest arm is at most half the largest", () => {
  const baseline = arm("control", 40, null);
  const atThreshold = ofKind(
    detectExperimentIssues(baseline, [arm("treatment", 20)], NO_CAPABILITIES),
    "arm_imbalance",
  );
  const aboveThreshold = ofKind(
    detectExperimentIssues(baseline, [arm("treatment", 21)], NO_CAPABILITIES),
    "arm_imbalance",
  );

  assert.deepEqual(
    {
      atThreshold: atThreshold.map(
        ({ kind, severity, arm: issueArm, smallestArm, largestArm, sampleRatio }) => ({
          kind,
          severity,
          arm: issueArm,
          smallestArm,
          largestArm,
          sampleRatio,
        }),
      ),
      aboveThreshold,
    },
    {
      atThreshold: [
        {
          kind: "arm_imbalance",
          severity: "info",
          arm: null,
          smallestArm: "treatment",
          largestArm: "control",
          sampleRatio: 0.5,
        },
      ],
      aboveThreshold: [],
    },
  );
});

test("error-rate delta error fires at an absolute 0.05 change, but not below it", () => {
  const issues = detectExperimentIssues(
    arm("control", 20, null),
    [
      arm(
        "threshold-treatment",
        20,
        withDeltas({ errorRate: { absolute: -0.05, relative: -0.5 } }),
      ),
      arm("below-treatment", 20, withDeltas({ errorRate: { absolute: 0.049, relative: 0.49 } })),
    ],
    NO_CAPABILITIES,
  );

  assert.deepEqual(
    ofKind(issues, "error_rate_delta").map(({ kind, severity, arm: issueArm, delta }) => ({
      kind,
      severity,
      arm: issueArm,
      delta,
    })),
    [
      {
        kind: "error_rate_delta",
        severity: "error",
        arm: "threshold-treatment",
        delta: -0.05,
      },
    ],
  );
});

test("error-rate threshold survives floating-point deltas from arm metrics", () => {
  const sharedMetrics = {
    traceCount: 20,
    averageLatencyMs: 100,
    p50LatencyMs: 90,
    p95LatencyMs: 120,
    averageInputTokens: 100,
    averageOutputTokens: 50,
    averageCostUsd: 0.01,
    averageSearchCount: 1,
    averageSearchHitCount: 1,
  };
  const [baseline, treatment] = compareArmMetrics("control", [
    { ...sharedMetrics, arm: "control", errorTraceCount: 2 },
    { ...sharedMetrics, arm: "treatment", errorTraceCount: 3 },
  ]);

  assert.deepEqual(
    ofKind(detectExperimentIssues(baseline, [treatment], NO_CAPABILITIES), "error_rate_delta").map(
      ({ arm: issueArm }) => issueArm,
    ),
    ["treatment"],
  );
});

test("capability-absent warning fires when baseline appearances reach 3, but not below it", () => {
  const capabilitySet = capabilities([
    {
      type: "tool",
      id: "deploy",
      baselineAppearances: 3,
      baselineAverageRank: 1,
      arms: [
        {
          arm: "treatment",
          appearances: 0,
          averageRank: null,
          rankDelta: null,
          absent: true,
        },
      ],
      maxAbsoluteRankDelta: null,
    },
    {
      type: "skill",
      id: "rare-skill",
      baselineAppearances: 2,
      baselineAverageRank: 1,
      arms: [
        {
          arm: "treatment",
          appearances: 0,
          averageRank: null,
          rankDelta: null,
          absent: true,
        },
      ],
      maxAbsoluteRankDelta: null,
    },
  ]);

  const issues = detectExperimentIssues(
    arm("control", 20, null),
    [arm("treatment")],
    capabilitySet,
  );

  assert.deepEqual(
    ofKind(issues, "capability_absent").map(
      ({ kind, severity, arm: issueArm, capabilityType, capabilityId, baselineAppearances }) => ({
        kind,
        severity,
        arm: issueArm,
        capabilityType,
        capabilityId,
        baselineAppearances,
      }),
    ),
    [
      {
        kind: "capability_absent",
        severity: "warning",
        arm: "treatment",
        capabilityType: "tool",
        capabilityId: "deploy",
        baselineAppearances: 3,
      },
    ],
  );
});

test("ranking-divergence warning fires at an absolute 3-rank change, but not below it", () => {
  const capabilitySet = capabilities([
    {
      type: "skill",
      id: "incident-response",
      baselineAppearances: 4,
      baselineAverageRank: 2,
      arms: [
        {
          arm: "threshold-treatment",
          appearances: 4,
          averageRank: 5,
          rankDelta: 3,
          absent: false,
        },
        {
          arm: "below-treatment",
          appearances: 4,
          averageRank: 4.99,
          rankDelta: 2.99,
          absent: false,
        },
      ],
      maxAbsoluteRankDelta: 3,
    },
  ]);

  const issues = detectExperimentIssues(
    arm("control", 20, null),
    [arm("threshold-treatment"), arm("below-treatment")],
    capabilitySet,
  );

  assert.deepEqual(
    ofKind(issues, "ranking_divergence").map(
      ({ kind, severity, arm: issueArm, capabilityType, capabilityId, rankDelta }) => ({
        kind,
        severity,
        arm: issueArm,
        capabilityType,
        capabilityId,
        rankDelta,
      }),
    ),
    [
      {
        kind: "ranking_divergence",
        severity: "warning",
        arm: "threshold-treatment",
        capabilityType: "skill",
        capabilityId: "incident-response",
        rankDelta: 3,
      },
    ],
  );
});

test("ranking threshold survives floating-point averages from capability hits", () => {
  const capabilitySet = compareCapabilities(
    "control",
    ["control", "treatment"],
    [
      ...[1, 2, 4].map((rank, index) => rankedSearchSpan("control", `control-${index}`, rank)),
      ...[4, 5, 7].map((rank, index) => rankedSearchSpan("treatment", `treatment-${index}`, rank)),
    ],
  );

  assert.deepEqual(
    ofKind(
      detectExperimentIssues(arm("control"), [arm("treatment")], capabilitySet),
      "ranking_divergence",
    ).map(({ arm: issueArm }) => issueArm),
    ["treatment"],
  );
});

test("latency-delta warning fires at an absolute 25% p95-latency change, but not below it", () => {
  const issues = detectExperimentIssues(
    arm("control", 20, null),
    [
      arm(
        "threshold-treatment",
        20,
        withDeltas({ p95LatencyMs: { absolute: -30, relative: -0.25 } }),
      ),
      arm(
        "below-treatment",
        20,
        withDeltas({ p95LatencyMs: { absolute: 29.88, relative: 0.249 } }),
      ),
    ],
    NO_CAPABILITIES,
  );

  assert.deepEqual(
    ofKind(issues, "latency_delta").map(({ kind, severity, arm: issueArm, relativeDelta }) => ({
      kind,
      severity,
      arm: issueArm,
      relativeDelta,
    })),
    [
      {
        kind: "latency_delta",
        severity: "warning",
        arm: "threshold-treatment",
        relativeDelta: -0.25,
      },
    ],
  );
});

test("latency threshold survives floating-point deltas from arm metrics", () => {
  const sharedMetrics = {
    traceCount: 20,
    errorTraceCount: 0,
    averageLatencyMs: 1,
    p50LatencyMs: 1,
    averageInputTokens: 100,
    averageOutputTokens: 50,
    averageCostUsd: 0.01,
    averageSearchCount: 1,
    averageSearchHitCount: 1,
  };
  const [baseline, treatment] = compareArmMetrics("control", [
    { ...sharedMetrics, arm: "control", p95LatencyMs: 1.1 },
    { ...sharedMetrics, arm: "treatment", p95LatencyMs: 1.375 },
  ]);

  assert.deepEqual(
    ofKind(detectExperimentIssues(baseline, [treatment], NO_CAPABILITIES), "latency_delta").map(
      ({ arm: issueArm }) => issueArm,
    ),
    ["treatment"],
  );
});

test("issues sort by severity, then kind, then arm", () => {
  const capabilitySet = capabilities([
    {
      type: "tool",
      id: "deploy",
      baselineAppearances: 3,
      baselineAverageRank: 1,
      arms: [
        {
          arm: "zeta",
          appearances: 0,
          averageRank: null,
          rankDelta: null,
          absent: true,
        },
        {
          arm: "alpha",
          appearances: 0,
          averageRank: null,
          rankDelta: null,
          absent: true,
        },
      ],
      maxAbsoluteRankDelta: null,
    },
    {
      type: "skill",
      id: "incident-response",
      baselineAppearances: 4,
      baselineAverageRank: 1,
      arms: [
        {
          arm: "alpha",
          appearances: 4,
          averageRank: 4,
          rankDelta: 3,
          absent: false,
        },
      ],
      maxAbsoluteRankDelta: 3,
    },
  ]);

  const issues = detectExperimentIssues(
    arm("control", 10, null),
    [
      arm(
        "zeta",
        20,
        withDeltas({
          errorRate: { absolute: 0.05, relative: 1 },
          p95LatencyMs: { absolute: 30, relative: 0.25 },
        }),
      ),
      arm("alpha", 40, withDeltas({ errorRate: { absolute: 0.05, relative: 1 } })),
    ],
    capabilitySet,
  );

  assert.deepEqual(
    issues.map(({ severity, kind, arm: issueArm }) => `${severity}:${kind}:${issueArm ?? ""}`),
    [
      "error:error_rate_delta:alpha",
      "error:error_rate_delta:zeta",
      "warning:capability_absent:alpha",
      "warning:capability_absent:zeta",
      "warning:latency_delta:zeta",
      "warning:ranking_divergence:alpha",
      "info:arm_imbalance:",
      "info:low_sample:control",
    ],
  );
});

function arm(
  name: string,
  traceCount = 20,
  deltas: ArmMetricDeltas | null = ZERO_DELTAS,
): ComparedArm {
  return {
    arm: name,
    metrics: {
      arm: name,
      traceCount,
      errorTraceCount: 0,
      errorRate: 0,
      averageLatencyMs: 100,
      p50LatencyMs: 90,
      p95LatencyMs: 120,
      averageInputTokens: 100,
      averageOutputTokens: 50,
      averageCostUsd: 0.01,
      averageSearchCount: 1,
      averageSearchHitCount: 1,
    },
    deltas,
  };
}

function ofKind<K extends ExperimentIssueKind>(
  issues: ExperimentIssue[],
  kind: K,
): Array<Extract<ExperimentIssue, { kind: K }>> {
  return issues.filter(
    (issue): issue is Extract<ExperimentIssue, { kind: K }> => issue.kind === kind,
  );
}

function withDeltas(overrides: Partial<ArmMetricDeltas>): ArmMetricDeltas {
  return { ...ZERO_DELTAS, ...overrides };
}

function capabilities(rows: CapabilityComparison[]): CapabilityComparisonSet {
  return {
    hasRankings: true,
    rows,
    reportedHitMetrics: [],
  };
}

function rankedSearchSpan(armName: string, spanId: string, rank: number) {
  return {
    arm: armName,
    traceId: `trace-${spanId}`,
    spanId,
    reportedHitCount: 1,
    hits: [{ type: "tool" as const, id: "deploy", rank, score: null }],
  };
}
