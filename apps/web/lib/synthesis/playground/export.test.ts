import assert from "node:assert/strict";
import { test } from "node:test";
import { collectEdits, editsToDiff, editsToJson } from "@/lib/synthesis/playground/export";
import { BENCH_SKILL_DEFAULTS, BENCH_TOOL_DEFAULTS } from "@/lib/synthesis/playground/test-support";
import type { BenchSkill, BenchTool, DraftsByKind } from "@/lib/synthesis/playground/types";

const CONTEXT = { projectSlug: "agent-demo", generatedAt: "2026-08-14T12:00:00Z" };

const skill = (name: string, over: Partial<BenchSkill> = {}): BenchSkill => ({
  ...BENCH_SKILL_DEFAULTS,
  id: `id-${name}`,
  name,
  description: `Stored ${name} description.`,
  tags: ["git"],
  tools: [],
  status: "published",
  version: 1,
  ...over,
});

const tool = (name: string, over: Partial<BenchTool> = {}): BenchTool => ({
  ...BENCH_TOOL_DEFAULTS,
  name,
  description: `Stored ${name} description.`,
  hasDefinition: true,
  calls: 3,
  ...over,
});

const NO_DRAFTS: DraftsByKind = { skill: {}, tool: {} };

test("collectEdits reports only what actually differs from what is stored", () => {
  const drafts: DraftsByKind = {
    skill: {
      "deploy-service": { description: "A rewritten deploy description." },
      // Same text as stored: opening a row and saving it unchanged is not an
      // edit, and exporting it would ask someone to apply a no-op.
      "review-pull-request": { description: "Stored review-pull-request description." },
    },
    tool: { ripgrep: { description: "A rewritten ripgrep description." } },
  };

  const edits = collectEdits(
    [skill("deploy-service"), skill("review-pull-request")],
    [tool("ripgrep"), tool("github_api")],
    drafts,
  );

  assert.deepEqual(
    edits.map((edit) => [edit.kind, edit.id]),
    [
      ["skill", "deploy-service"],
      ["tool", "ripgrep"],
    ],
  );
  assert.deepEqual(edits[0].description, {
    from: "Stored deploy-service description.",
    to: "A rewritten deploy description.",
  });
});

test("collectEdits orders skills before tools, alphabetically within each", () => {
  // The export is something people re-copy and compare. A set that reshuffled
  // between copies would read as a change that never happened.
  const drafts: DraftsByKind = {
    skill: {
      "b-skill": { description: "changed" },
      "a-skill": { description: "changed" },
    },
    tool: {
      z_tool: { description: "changed" },
      a_tool: { description: "changed" },
    },
  };
  const edits = collectEdits(
    [skill("b-skill"), skill("a-skill")],
    [tool("z_tool"), tool("a_tool")],
    drafts,
  );
  assert.deepEqual(
    edits.map((edit) => edit.id),
    ["a-skill", "b-skill", "a_tool", "z_tool"],
  );
});

test("a tag change is carried, and an unchanged tag list is not", () => {
  const edits = collectEdits([skill("deploy-service")], [], {
    skill: {
      "deploy-service": { description: "changed", tags: ["git", "deploy"] },
    },
    tool: {},
  });
  assert.deepEqual(edits[0].tags, { from: ["git"], to: ["git", "deploy"] });

  const noTagChange = collectEdits([skill("deploy-service")], [], {
    skill: { "deploy-service": { description: "changed", tags: ["git"] } },
    tool: {},
  });
  assert.equal(noTagChange[0].tags, undefined);
});

test("nothing edited exports nothing", () => {
  assert.deepEqual(collectEdits([skill("a")], [tool("b")], NO_DRAFTS), []);
});

test("editsToJson round-trips through JSON.parse", () => {
  const edits = collectEdits([skill("deploy-service")], [], {
    skill: { "deploy-service": { description: "New text." } },
    tool: {},
  });
  const parsed = JSON.parse(editsToJson(edits, CONTEXT));

  assert.equal(parsed.project, "agent-demo");
  assert.equal(parsed.generatedAt, CONTEXT.generatedAt);
  assert.equal(parsed.edits.length, 1);
  assert.deepEqual(parsed.edits[0].description, {
    from: "Stored deploy-service description.",
    to: "New text.",
  });
});

test("editsToDiff shows the before and after under a kind-qualified header", () => {
  const edits = collectEdits([], [tool("ripgrep")], {
    skill: {},
    tool: { ripgrep: { description: "Search a tree, fast." } },
  });
  const diff = editsToDiff(edits, CONTEXT);

  assert.match(diff, /--- a\/tool\/ripgrep/);
  assert.match(diff, /\+\+\+ b\/tool\/ripgrep/);
  assert.match(diff, /^-Stored ripgrep description\.$/m);
  assert.match(diff, /^\+Search a tree, fast\.$/m);
  // The receiving end has to know Ratel cannot apply a tool change itself.
  assert.match(diff, /whoever runs the agent/);
});

test("the exports carry the feature's UI name and no Cloud source", () => {
  const edits = collectEdits([], [tool("ripgrep")], {
    skill: {},
    tool: { ripgrep: { description: "Search a tree, fast." } },
  });

  assert.match(editsToDiff(edits, CONTEXT), /^# Test a search edits: /);
  assert.equal(JSON.parse(editsToJson(edits, CONTEXT)).source, "ratel-test-a-search");
});

test("editsToDiff marks an absent description rather than emitting a blank line", () => {
  // A tool telemetry has seen but no sync has described has no text at all, and
  // an empty "-" line would read as a deletion of nothing.
  const edits = collectEdits([], [tool("undescribed", { description: "", hasDefinition: false })], {
    skill: {},
    tool: { undescribed: { description: "First description." } },
  });
  const diff = editsToDiff(edits, CONTEXT);
  assert.match(diff, /^-\(no description\)$/m);
  assert.match(diff, /^\+First description\.$/m);
});

test("editsToDiff prefixes every line of a multi-line description", () => {
  const edits = collectEdits([], [tool("ripgrep")], {
    skill: {},
    tool: { ripgrep: { description: "First line.\nSecond line." } },
  });
  const diff = editsToDiff(edits, CONTEXT);
  assert.match(diff, /^\+First line\.$/m);
  assert.match(diff, /^\+Second line\.$/m);
});

test("editsToDiff includes a tag change when there is one", () => {
  const edits = collectEdits([skill("deploy-service")], [], {
    skill: { "deploy-service": { description: "New.", tags: ["deploy"] } },
    tool: {},
  });
  const diff = editsToDiff(edits, CONTEXT);
  assert.match(diff, /@@ tags @@/);
  assert.match(diff, /^-git$/m);
  assert.match(diff, /^\+deploy$/m);
});
