import assert from "node:assert/strict";
import { test } from "node:test";
import { runPlayground } from "./run";
import { BENCH_SKILL_DEFAULTS, BENCH_TOOL_DEFAULTS } from "./test-support";
import type { BenchSkill, BenchTool, DraftsByKind, RankOptions } from "./types";

const SKILLS: BenchSkill[] = [
  {
    ...BENCH_SKILL_DEFAULTS,
    id: "s1",
    name: "review-pull-request",
    description: "Review a pull request and flag risky changes in the diff.",
    tags: ["git"],
    tools: [],
    status: "published",
    version: 1,
  },
  {
    ...BENCH_SKILL_DEFAULTS,
    id: "s2",
    name: "explain-error",
    description: "Error tool.",
    tags: [],
    tools: [],
    status: "draft",
    version: 1,
  },
];

const TOOLS: BenchTool[] = [
  {
    ...BENCH_TOOL_DEFAULTS,
    name: "github_api",
    description: "Read and write GitHub pull requests.",
    hasDefinition: true,
    calls: 5,
  },
];

const OPTIONS: RankOptions = {
  mode: "bm25",
  topKSkills: 5,
  topKTools: 5,
  embeddingWeight: 0.5,
};

const noDrafts: DraftsByKind = { skill: {}, tool: {} };

test("an unedited run reports no edits and reuses one ranking", () => {
  const run = runPlayground({
    query: "review a pull request",
    skills: SKILLS,
    tools: TOOLS,
    drafts: noDrafts,
    options: OPTIONS,
  });
  assert.equal(run.hasEdits, false);
  assert.deepEqual(run.changes, []);
  // Identical object, not merely equal: the panel keys "show two columns" off
  // `hasEdits`, and a second ranking pass would be wasted work.
  assert.equal(run.drafted, run.baseline);
  assert.equal(run.diff.skills.summary.moved, 0);
  assert.equal(run.diff.skills.summary.dropped, 0);
  assert.equal(run.diff.skills.summary.added, 0);
});

test("an edit that makes a skill retrievable shows up as an addition", () => {
  const run = runPlayground({
    query: "why is this throwing a null pointer",
    skills: SKILLS,
    tools: TOOLS,
    drafts: {
      skill: {
        "explain-error": {
          description:
            "Explain a runtime error or stack trace: identify the root cause and why something is throwing.",
        },
      },
      tool: {},
    },
    options: OPTIONS,
  });

  assert.equal(run.hasEdits, true);
  assert.equal(run.changes.length, 1);
  assert.equal(run.changes[0].id, "explain-error");
  assert.equal(
    run.baseline.skills.some((hit) => hit.id === "explain-error"),
    false,
  );
  assert.equal(
    run.drafted.skills.some((hit) => hit.id === "explain-error"),
    true,
  );
  assert.equal(run.diff.skills.summary.added, 1);
});

test("an edit that ruins a description shows up as a drop", () => {
  // Phrased so the match can only come from the description: the skill's name
  // shares no term with it, so gutting the prose really does strand the skill.
  const run = runPlayground({
    query: "flag risky changes in the diff",
    skills: SKILLS,
    tools: TOOLS,
    drafts: {
      skill: { "review-pull-request": { description: "Does a thing." } },
      tool: {},
    },
    options: OPTIONS,
  });
  assert.equal(
    run.baseline.skills.some((hit) => hit.id === "review-pull-request"),
    true,
  );
  assert.equal(
    run.drafted.skills.some((hit) => hit.id === "review-pull-request"),
    false,
  );
  assert.equal(run.diff.skills.summary.dropped, 1);
});

test("a tool-only edit leaves the skills bucket untouched", () => {
  const run = runPlayground({
    query: "review a pull request",
    skills: SKILLS,
    tools: TOOLS,
    drafts: {
      skill: {},
      tool: { github_api: { description: "Completely unrelated prose." } },
    },
    options: OPTIONS,
  });
  assert.equal(run.hasEdits, true);
  assert.deepEqual(
    run.baseline.skills.map((hit) => hit.id),
    run.drafted.skills.map((hit) => hit.id),
  );
  assert.equal(run.diff.skills.summary.moved, 0);
});
