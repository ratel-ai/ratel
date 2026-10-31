import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ArmImbalanceIssue,
  ErrorRateDeltaIssue,
  ExperimentIssue,
  LatencyDeltaIssue,
  RankingDivergenceIssue,
} from "@/lib/synthesis/experiments/types";
import { buildExperimentIssueCards } from "./experiment-issues";

test("buildExperimentIssueCards maps an arm issue to a filtered trace-evidence link", () => {
  const issue: ErrorRateDeltaIssue = {
    kind: "error_rate_delta",
    severity: "error",
    arm: "candidate/beta",
    message: "candidate/beta error rate differs from control by 0.08",
    delta: 0.08,
  };

  assert.deepEqual(
    buildExperimentIssueCards([issue], {
      experimentName: "ranking v2",
      project: "agent one",
      range: "custom",
      from: "2026-07-01",
      to: "2026-07-15",
    }),
    [
      {
        kind: "error_rate_delta",
        severity: "error",
        title: "Error rate changed",
        detail: "candidate/beta error rate is 8 percentage points higher than baseline",
        evidenceLabel: "View candidate/beta traces",
        evidenceHref:
          "/traces?project=agent+one&range=custom&from=2026-07-01&to=2026-07-15&experiment=ranking+v2&arm=candidate%2Fbeta&exactTags=1",
      },
    ],
  );
});

test("buildExperimentIssueCards uses the scoped trace root for evidence", () => {
  const issue: ErrorRateDeltaIssue = {
    kind: "error_rate_delta",
    severity: "error",
    arm: "candidate",
    message: "candidate error rate differs from control",
    delta: 0.08,
  };

  assert.equal(
    buildExperimentIssueCards([issue], {
      experimentName: "ranking-v2",
      traceRoot: "/project/01234567-89ab-cdef-0123-456789abcdef/traces",
    })[0]?.evidenceHref,
    "/project/01234567-89ab-cdef-0123-456789abcdef/traces?experiment=ranking-v2&arm=candidate&exactTags=1",
  );
});

test("buildExperimentIssueCards rounds and explains a lower error rate", () => {
  const issue: ErrorRateDeltaIssue = {
    kind: "error_rate_delta",
    severity: "error",
    arm: "candidate",
    message: "machine-oriented fallback -0.1014",
    delta: -0.1014,
  };

  assert.equal(
    buildExperimentIssueCards([issue], {
      experimentName: "ranking-v2",
    })[0]?.detail,
    "candidate error rate is 10.1 percentage points lower than baseline",
  );
});

test("buildExperimentIssueCards rounds and explains a higher p95 latency", () => {
  const issue: LatencyDeltaIssue = {
    kind: "latency_delta",
    severity: "warning",
    arm: "candidate",
    message: "candidate p95 latency differs by 25.36%",
    relativeDelta: 0.2536,
  };

  assert.equal(
    buildExperimentIssueCards([issue], {
      experimentName: "ranking-v2",
    })[0]?.detail,
    "candidate p95 latency is 25.4% higher than baseline",
  );
});

test("buildExperimentIssueCards rounds and explains a lower capability rank", () => {
  const issue: RankingDivergenceIssue = {
    kind: "ranking_divergence",
    severity: "warning",
    arm: "candidate",
    message: "skill triage rank differs by 3.26",
    capabilityType: "skill",
    capabilityId: "triage",
    rankDelta: 3.26,
  };

  assert.equal(
    buildExperimentIssueCards([issue], {
      experimentName: "ranking-v2",
    })[0]?.detail,
    "candidate ranks skill triage 3.3 places lower than baseline",
  );
});

test("buildExperimentIssueCards links an experiment-wide issue without an arm filter", () => {
  const issue: ArmImbalanceIssue = {
    kind: "arm_imbalance",
    severity: "info",
    arm: null,
    message: "candidate has 10 traces versus control with 40",
    smallestArm: "candidate",
    largestArm: "control",
    sampleRatio: 0.25,
  };

  assert.deepEqual(
    buildExperimentIssueCards([issue], {
      experimentName: "ranking-v2",
    }),
    [
      {
        kind: "arm_imbalance",
        severity: "info",
        title: "Arm sample sizes imbalanced",
        detail: "candidate has 10 traces versus control with 40",
        evidenceLabel: "View experiment traces",
        evidenceHref: "/traces?experiment=ranking-v2&exactTags=1",
      },
    ],
  );
});

test("buildExperimentIssueCards gives every issue kind a concise panel title", () => {
  const issues: ExperimentIssue[] = [
    {
      kind: "missing_arm",
      severity: "error",
      arm: null,
      message: "expected at least 2 experiment arms",
      observedArms: ["control"],
    },
    {
      kind: "capability_absent",
      severity: "warning",
      arm: "candidate",
      message: "tool deploy is absent",
      capabilityType: "tool",
      capabilityId: "deploy",
      baselineAppearances: 4,
    },
    {
      kind: "latency_delta",
      severity: "warning",
      arm: "candidate",
      message: "candidate p95 latency differs by 25%",
      relativeDelta: 0.25,
    },
    {
      kind: "ranking_divergence",
      severity: "warning",
      arm: "candidate",
      message: "skill triage rank differs by 3",
      capabilityType: "skill",
      capabilityId: "triage",
      rankDelta: 3,
    },
    {
      kind: "low_sample",
      severity: "info",
      arm: "candidate",
      message: "candidate has 8 traces",
      traceCount: 8,
    },
  ];

  assert.deepEqual(
    buildExperimentIssueCards(issues, {
      experimentName: "ranking-v2",
    }).map(({ kind, title }) => ({ kind, title })),
    [
      {
        kind: "missing_arm",
        title: "Experiment arm missing",
      },
      {
        kind: "capability_absent",
        title: "Capability absent",
      },
      {
        kind: "latency_delta",
        title: "P95 latency changed",
      },
      {
        kind: "ranking_divergence",
        title: "Capability ranking changed",
      },
      {
        kind: "low_sample",
        title: "Low sample size",
      },
    ],
  );
});

test("buildExperimentIssueCards sorts by severity, kind, arm, then detail", () => {
  const issues: ExperimentIssue[] = [
    {
      kind: "low_sample",
      severity: "info",
      arm: "zeta",
      message: "zeta has 8 traces",
      traceCount: 8,
    },
    {
      kind: "capability_absent",
      severity: "warning",
      arm: "alpha",
      message: "Zulu evidence",
      capabilityType: "skill",
      capabilityId: "zulu",
      baselineAppearances: 3,
    },
    {
      kind: "missing_arm",
      severity: "error",
      arm: null,
      message: "expected at least 2 experiment arms",
      observedArms: ["control"],
    },
    {
      kind: "error_rate_delta",
      severity: "error",
      arm: "zeta",
      message: "zeta error rate differs by 0.08",
      delta: 0.08,
    },
    {
      kind: "capability_absent",
      severity: "warning",
      arm: "zeta",
      message: "zeta is missing deploy",
      capabilityType: "tool",
      capabilityId: "deploy",
      baselineAppearances: 3,
    },
    {
      kind: "error_rate_delta",
      severity: "error",
      arm: "alpha",
      message: "alpha error rate differs by 0.05",
      delta: 0.05,
    },
    {
      kind: "capability_absent",
      severity: "warning",
      arm: "alpha",
      message: "Alpha evidence",
      capabilityType: "skill",
      capabilityId: "alpha",
      baselineAppearances: 3,
    },
  ];

  assert.deepEqual(
    buildExperimentIssueCards(issues, {
      experimentName: "ranking-v2",
    }).map(
      ({ severity, kind, evidenceLabel, detail }) =>
        `${severity}:${kind}:${evidenceLabel}:${detail}`,
    ),
    [
      "error:error_rate_delta:View alpha traces:alpha error rate is 5 percentage points higher than baseline",
      "error:error_rate_delta:View zeta traces:zeta error rate is 8 percentage points higher than baseline",
      "error:missing_arm:View experiment traces:expected at least 2 experiment arms",
      "warning:capability_absent:View alpha traces:Alpha evidence",
      "warning:capability_absent:View alpha traces:Zulu evidence",
      "warning:capability_absent:View zeta traces:zeta is missing deploy",
      "info:low_sample:View zeta traces:zeta has 8 traces",
    ],
  );
});

test("buildExperimentIssueCards preserves exact experiment and arm values in evidence links", () => {
  const issue: ErrorRateDeltaIssue = {
    kind: "error_rate_delta",
    severity: "error",
    arm: " candidate + beta ",
    message: "error rate changed",
    delta: 0.05,
  };

  assert.equal(
    buildExperimentIssueCards([issue], {
      experimentName: " ranking/v2 ",
    })[0]?.evidenceHref,
    "/traces?experiment=+ranking%2Fv2+&arm=+candidate+%2B+beta+&exactTags=1",
  );
});
