import assert from "node:assert/strict";
import { test } from "node:test";
import { pickHeadline, topOneShare } from "@/lib/synthesis/quality/headline";
import { scoreObservations } from "@/lib/synthesis/quality/metrics";
import type { ArmQuality, TierQuality } from "@/lib/synthesis/quality/service";

function arm(name: string, ranks: (number | null)[]): ArmQuality {
  return {
    arm: name,
    role: null,
    score: scoreObservations(ranks.map((rank) => ({ rank }))),
    bias: "independent",
    biasNote: "",
    separatedFromBaseline: false,
  };
}

function tier(name: "revealed" | "judged", arms: ArmQuality[], comparable = true): TierQuality {
  return { tier: name, baselineArm: "legacy", arms, comparable };
}

test("topOneShare is the share of searches whose answer came first", () => {
  assert.equal(
    topOneShare(scoreObservations([{ rank: 1 }, { rank: 2 }, { rank: null }, { rank: 1 }])),
    0.5,
  );
  assert.equal(topOneShare(scoreObservations([])), null);
});

test("pickHeadline leads with the answer key and compares the baseline on it", () => {
  const choice = pickHeadline(
    [
      tier("revealed", [arm("legacy", [1]), arm("ratel", [1])]),
      tier("judged", [arm("legacy", [1, null]), arm("ratel", [1, 1])]),
    ],
    "ratel",
  )!;

  assert.equal(choice.tier.tier, "judged");
  assert.equal(choice.subject.score.n, 2);
  assert.equal(choice.baseline?.arm, "legacy");
  assert.ok(choice.gap && choice.gap.total > 0);
});

test("pickHeadline falls back to what the agent ran, and hides a non-comparable gap", () => {
  const choice = pickHeadline(
    [
      tier("revealed", [arm("legacy", [1]), arm("ratel", [2])], false),
      tier("judged", [arm("legacy", []), arm("ratel", [])]),
    ],
    "ratel",
  )!;

  assert.equal(choice.tier.tier, "revealed");
  assert.equal(choice.baseline, null);
  assert.equal(choice.gap, null);
});

test("pickHeadline returns nothing when no search has a known answer", () => {
  assert.equal(pickHeadline([tier("revealed", []), tier("judged", [])], "ratel"), null);
  assert.equal(pickHeadline([tier("judged", [arm("ratel", [1])])], undefined), null);
});

test("an arm that served its searches never headlines on what the agent ran", () => {
  const served = { ...arm("ratel", [1, 1, 1]), bias: "self-selected" as const };
  assert.equal(
    pickHeadline(
      [tier("revealed", [arm("legacy", [1, null, 2]), served]), tier("judged", [])],
      "ratel",
    ),
    null,
  );
});
