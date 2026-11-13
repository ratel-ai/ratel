import assert from "node:assert/strict";
import { test } from "node:test";
import type { StoredTopicPattern } from "@/lib/readings/topics/types";
import {
  type IntentGapInput,
  pickSkillGaps,
  SKILL_GAP_MIN_RUNS,
  SKILL_GAP_MIN_TURNS,
  SKILL_GAPS_SHOWN,
  skillCoverage,
} from "@/lib/views/fixes/skill-gaps";

function intent(
  topicId: string,
  turns: number,
  over: Partial<StoredTopicPattern> = {},
): IntentGapInput {
  return {
    topicId,
    name: `Intent ${topicId}`,
    turns,
    pattern: {
      withCalls: turns,
      tools: [
        { id: "get_purchase_order", turns: Math.round(turns * 0.8) },
        { id: "track_material_delivery", turns: Math.round(turns * 0.75) },
      ],
      runs: Math.round(turns * 0.7),
      inOrder: Math.round(turns * 0.68),
      also: [],
      helpers: [],
      firsts: [],
      comesBefore: [],
      skills: { invoked: 0, offered: 0 },
      ...over,
    },
  };
}

test("an intent asked often, worked out step by step, with no skill near it, is a gap", () => {
  const [gap] = pickSkillGaps([intent("t_delivery", 218)], []);
  assert.deepEqual(gap, {
    topicId: "t_delivery",
    name: "Intent t_delivery",
    turns: 218,
    steps: ["get_purchase_order", "track_material_delivery"],
    runs: 153,
    inOrder: 148,
  });
});

test("covered, conservatively: a skill that ran once, a skill offered once, or a published skill naming every step", () => {
  const base = intent("t", 100);
  assert.equal(skillCoverage(base, []), null);
  assert.equal(skillCoverage(intent("t", 100, { skills: { invoked: 1, offered: 0 } }), []), "ran");
  assert.equal(
    skillCoverage(intent("t", 100, { skills: { invoked: 0, offered: 1 } }), []),
    "offered",
  );
  assert.equal(
    skillCoverage(
      intent("t", 100, {
        tools: [
          { id: "skill:po-tracking", turns: 60 },
          { id: "track_material_delivery", turns: 70 },
        ],
      }),
      [],
    ),
    "ran",
  );
  const steps = ["get_purchase_order", "track_material_delivery"];
  assert.equal(
    skillCoverage(base, [{ name: "po-tracking", tools: [...steps, "notify_team"] }]),
    "published",
  );
  assert.equal(
    skillCoverage(base, [{ name: "po-lookup", tools: ["get_purchase_order"] }]),
    null,
    "a skill naming one of the two steps does not cover it",
  );
  assert.equal(
    pickSkillGaps([intent("t", 100, { skills: { invoked: 0, offered: 2 } })], []).length,
    0,
  );
});

test("worth a skill: enough turns, two steps or more, run together often enough", () => {
  assert.equal(SKILL_GAP_MIN_TURNS, 20);
  assert.equal(SKILL_GAP_MIN_RUNS, 10);
  assert.equal(
    pickSkillGaps([intent("t", SKILL_GAP_MIN_TURNS - 1)], []).length,
    0,
    "too few turns",
  );
  assert.equal(
    pickSkillGaps([intent("t", 100, { tools: [{ id: "update_task", turns: 90 }] })], []).length,
    0,
    "one call is no steps to write down",
  );
  assert.equal(
    pickSkillGaps([intent("t", 100, { runs: SKILL_GAP_MIN_RUNS - 1 })], []).length,
    0,
    "the steps seldom run together",
  );
  assert.equal(pickSkillGaps([intent("t", 100, { tools: [] })], []).length, 0, "no pattern");
});

test("the busiest few, so a project without skills sees the ones that matter", () => {
  const intents = [intent("t_a", 40), intent("t_b", 200), intent("t_c", 90), intent("t_d", 120)];
  assert.equal(SKILL_GAPS_SHOWN, 3);
  assert.deepEqual(
    pickSkillGaps(intents, []).map((gap) => gap.topicId),
    ["t_b", "t_d", "t_c"],
  );
  assert.deepEqual(
    pickSkillGaps(intents, [], { max: 1 }).map((gap) => gap.topicId),
    ["t_b"],
  );
});
