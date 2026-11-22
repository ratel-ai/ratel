import assert from "node:assert/strict";
import { test } from "node:test";
import type { CapabilityComparison, ExperimentSummary } from "@/lib/synthesis/experiments/types";
import {
  armRoleLabel,
  displayCapabilityRank,
  experimentDetailPath,
  experimentNameFromPathSegment,
  selectExperimentBanner,
  selectVisibleArms,
  sortCapabilitiesByVisibleDelta,
} from "./experiment-view";

test("experiment detail paths cannot become dot segments", () => {
  assert.equal(experimentDetailPath("."), "/experiments/~.");
  assert.equal(experimentDetailPath(".."), "/experiments/~..");
  assert.equal(experimentDetailPath("ranking/v2"), "/experiments/~ranking%2Fv2");
  assert.equal(experimentNameFromPathSegment("~ranking/v2"), "ranking/v2");
  assert.equal(experimentNameFromPathSegment("legacy-name"), "legacy-name");
});

test("displayCapabilityRank converts zero-based storage to human positions", () => {
  assert.equal(displayCapabilityRank(0), 1);
  assert.equal(displayCapabilityRank(2.5), 3.5);
  assert.equal(displayCapabilityRank(null), null);
});

test("selectVisibleArms always includes a lexically late baseline", () => {
  const arms = ["alpha", "beta", "canary", "control"].map((arm) => ({ arm }));

  assert.deepEqual(
    selectVisibleArms(arms, "control", 3).map(({ arm }) => arm),
    ["control", "alpha", "beta"],
  );
});

test("selectVisibleArms caps safely when the baseline is missing", () => {
  const arms = ["alpha", "beta", "canary", "delta"].map((arm) => ({ arm }));

  assert.deepEqual(
    selectVisibleArms(arms, "control", 3).map(({ arm }) => arm),
    ["alpha", "beta", "canary"],
  );
});

test("armRoleLabel numbers variants only when there is more than one", () => {
  assert.equal(armRoleLabel(-1, 0), "baseline");
  assert.equal(armRoleLabel(-1, 2), "baseline");
  assert.equal(armRoleLabel(0, 1), "variant");
  assert.equal(armRoleLabel(0, 2), "variant 1");
  assert.equal(armRoleLabel(1, 2), "variant 2");
});

test("sortCapabilitiesByVisibleDelta ignores an extreme hidden-arm movement", () => {
  const hiddenLeader = capability("hidden-leader", {
    control: 0,
    candidate: 0,
    observer: 0,
    hidden: 12,
  });
  const visibleLeader = capability("visible-leader", {
    control: 0,
    candidate: 3,
    observer: -1,
    hidden: 0,
  });

  assert.deepEqual(
    sortCapabilitiesByVisibleDelta(
      [hiddenLeader, visibleLeader],
      ["control", "candidate", "observer"],
      "control",
    ).map(({ id }) => id),
    ["visible-leader", "hidden-leader"],
  );
});

test("selectExperimentBanner prefers the active filter, then the latest signal", () => {
  const earlier = experiment("selected", "2026-07-20T00:00:00.000Z");
  const latest = experiment("latest", "2026-07-30T00:00:00.000Z");

  assert.equal(selectExperimentBanner([latest, earlier], "selected")?.name, "selected");
  assert.equal(selectExperimentBanner([earlier, latest], "")?.name, "latest");
});

test("selectExperimentBanner does not substitute an unrelated filtered experiment", () => {
  const latest = experiment("latest", "2026-07-30T00:00:00.000Z");

  assert.equal(selectExperimentBanner([latest], "outside-retained-window"), undefined);
});

function capability(id: string, deltas: Record<string, number>): CapabilityComparison {
  return {
    type: "skill",
    id,
    baselineAppearances: 10,
    baselineAverageRank: 1,
    arms: Object.entries(deltas).map(([arm, rankDelta]) => ({
      arm,
      appearances: 10,
      averageRank: 1 + rankDelta,
      rankDelta,
      absent: false,
    })),
    maxAbsoluteRankDelta: Math.max(...Object.values(deltas).map((delta) => Math.abs(delta))),
  };
}

function experiment(name: string, lastSeenAt: string): ExperimentSummary {
  return {
    name,
    mode: "split",
    baselineArm: "control",
    traceCount: 10,
    multiArmTraceCount: 0,
    arms: [
      { arm: "control", traceCount: 5, traceShare: 0.5 },
      { arm: "candidate", traceCount: 5, traceShare: 0.5 },
    ],
    firstSeenAt: new Date("2026-07-01T00:00:00.000Z"),
    lastSeenAt: new Date(lastSeenAt),
  };
}
