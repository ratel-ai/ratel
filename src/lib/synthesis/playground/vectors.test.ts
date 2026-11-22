import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilityIndexText } from "./rank";
import { BENCH_SKILL_DEFAULTS, BENCH_TOOL_DEFAULTS } from "./test-support";
import type { BenchSkill, BenchTool, DraftsByKind } from "./types";
import { assembleVectors, planVectorBatches } from "./vectors";

const SKILLS: BenchSkill[] = [
  {
    ...BENCH_SKILL_DEFAULTS,
    id: "s1",
    name: "alpha",
    description: "First skill.",
    tags: ["a"],
    tools: [],
    status: "published",
    version: 1,
  },
  {
    ...BENCH_SKILL_DEFAULTS,
    id: "s2",
    name: "beta",
    description: "Second skill.",
    tags: [],
    tools: [],
    status: "published",
    version: 1,
  },
];

const TOOLS: BenchTool[] = [
  {
    ...BENCH_TOOL_DEFAULTS,
    name: "tool-one",
    description: "First tool.",
    hasDefinition: true,
    calls: 1,
  },
  {
    ...BENCH_TOOL_DEFAULTS,
    name: "tool-two",
    description: "Second tool.",
    hasDefinition: true,
    calls: 2,
  },
];

const CATALOGS = { skills: SKILLS, tools: TOOLS };
const NO_DRAFTS: DraftsByKind = { skill: {}, tool: {} };
const EDIT_BETA_AND_TOOL_TWO: DraftsByKind = {
  skill: { beta: { description: "Rewritten second skill." } },
  tool: { "tool-two": { description: "Rewritten second tool." } },
};

/** Distinct one-dimensional vectors, so a misindexed read is unmistakable. */
const numbered = (count: number, offset = 0) =>
  Array.from({ length: count }, (_, i) => [offset + i]);

test("the query rides in the skills batch only", () => {
  const batches = planVectorBatches("a prompt", CATALOGS, NO_DRAFTS);
  assert.equal(batches.skillTexts[0], "a prompt");
  assert.equal(batches.skillTexts.length, 1 + SKILLS.length);
  // Including it in both would race the process cache across the two
  // concurrent calls and pay for the same text twice.
  assert.equal(batches.toolTexts.includes("a prompt"), false);
  assert.equal(batches.toolTexts.length, TOOLS.length);
});

test("only edited capabilities add a second text to their batch", () => {
  const batches = planVectorBatches("q", CATALOGS, EDIT_BETA_AND_TOOL_TWO);
  assert.equal(batches.skillTexts.length, 1 + SKILLS.length + 1);
  assert.equal(batches.toolTexts.length, TOOLS.length + 1);
  assert.match(batches.skillTexts.at(-1) ?? "", /Rewritten second skill/);
  assert.match(batches.toolTexts.at(-1) ?? "", /Rewritten second tool/);
});

test("batch texts are what the ranker indexes on", () => {
  const batches = planVectorBatches("q", CATALOGS, NO_DRAFTS);
  assert.equal(batches.skillTexts[1], capabilityIndexText(SKILLS[0]));
  assert.equal(batches.toolTexts[0], capabilityIndexText(TOOLS[0]));
});

test("assembleVectors maps every capability to its own vector", () => {
  const { baseline } = assembleVectors(
    CATALOGS,
    NO_DRAFTS,
    numbered(1 + SKILLS.length), // [query=0, alpha=1, beta=2]
    numbered(TOOLS.length, 10), // [tool-one=10, tool-two=11]
  );
  assert.deepEqual(baseline.query, [0]);
  assert.deepEqual(baseline.skills.get("alpha"), [1]);
  assert.deepEqual(baseline.skills.get("beta"), [2]);
  assert.deepEqual(baseline.tools.get("tool-one"), [10]);
  assert.deepEqual(baseline.tools.get("tool-two"), [11]);
});

test("the drafted set overrides only the edited capabilities", () => {
  const { baseline, drafted } = assembleVectors(
    CATALOGS,
    EDIT_BETA_AND_TOOL_TWO,
    numbered(1 + SKILLS.length + 1), // […, drafted beta = 3]
    numbered(TOOLS.length + 1, 10), // […, drafted tool-two = 12]
  );

  // Unedited capabilities are the same text in both runs, so the same vector.
  assert.deepEqual(drafted.skills.get("alpha"), baseline.skills.get("alpha"));
  assert.deepEqual(drafted.tools.get("tool-one"), baseline.tools.get("tool-one"));
  // Edited ones point at their drafted vector, at the tail of the batch.
  assert.deepEqual(drafted.skills.get("beta"), [3]);
  assert.deepEqual(drafted.tools.get("tool-two"), [12]);
  // …and the baseline still holds the stored reading.
  assert.deepEqual(baseline.skills.get("beta"), [2]);
  assert.deepEqual(baseline.tools.get("tool-two"), [11]);
  assert.deepEqual(drafted.query, baseline.query);
});

test("a plan and its assembly agree on length for every draft shape", () => {
  for (const drafts of [NO_DRAFTS, EDIT_BETA_AND_TOOL_TWO]) {
    const batches = planVectorBatches("q", CATALOGS, drafts);
    const { drafted } = assembleVectors(
      CATALOGS,
      drafts,
      numbered(batches.skillTexts.length),
      numbered(batches.toolTexts.length, 100),
    );
    // Every capability resolved to a real vector, with no empty fallback, which is
    // what a length disagreement between the two would produce.
    for (const vector of [...drafted.skills.values(), ...drafted.tools.values()]) {
      assert.equal(vector.length, 1);
    }
  }
});

test("an empty catalog still yields a usable query vector", () => {
  const empty = { skills: [], tools: [] };
  const batches = planVectorBatches("q", empty, NO_DRAFTS);
  assert.deepEqual(batches.skillTexts, ["q"]);
  assert.deepEqual(batches.toolTexts, []);

  const { baseline } = assembleVectors(empty, NO_DRAFTS, [[7]], []);
  assert.deepEqual(baseline.query, [7]);
  assert.equal(baseline.skills.size, 0);
  assert.equal(baseline.tools.size, 0);
});
