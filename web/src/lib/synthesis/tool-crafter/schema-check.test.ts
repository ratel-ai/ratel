import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Check,
  checkName,
  checkProposal,
  MAX_SCHEMA_BYTES,
  MAX_SCHEMA_DEPTH,
  MAX_SEARCHABLE_CHARS,
  validateInputSchema,
} from "@/lib/synthesis/tool-crafter/schema-check";
import type {
  CraftedProposalBody,
  CraftedToolDefinition,
  SourceTool,
} from "@/lib/synthesis/tool-crafter/types";

const source: SourceTool = {
  id: "find_task",
  name: "find_task",
  description: "Find a task.",
  searchableDescription: "find task",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};
const crafted = (over: Partial<CraftedToolDefinition> = {}): CraftedToolDefinition => ({
  name: "find_task",
  description: "Find a task.",
  searchableDescription: "find task ticket issue",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  outputNotes: null,
  dispatch: [{ sourceToolId: "find_task", when: "always", argumentMapping: {} }],
  ...over,
});
const rewrite = (tools: CraftedToolDefinition[]): CraftedProposalBody => ({
  kind: "rewrite_tool",
  sourceToolIds: ["find_task"],
  crafted: tools,
  hidden: [],
  rationale: "r",
  details: "d",
  expectedEffect: "e",
  migrationNotes: "m",
});
const catalog = new Set(["find_task", "assign_task"]);
const problems = (check: Check): string => (check.ok ? "" : check.problems.join(";"));

test("checkName rejects what a tool registry rejects, and a name already in the catalog unless the kind may keep it", () => {
  for (const bad of ["", "a", "1abc", "has space", "x".repeat(65), "dot.name"])
    assert.equal(checkName({ name: bad }, catalog).ok, false, JSON.stringify(bad));
  assert.equal(checkName({ name: "ab" }, catalog).ok, true);
  assert.equal(checkName({ name: "find-assign_task2" }, catalog).ok, true);
  assert.equal(checkName({ name: "assign_task" }, catalog).ok, false, "taken");
  assert.equal(
    checkName({ name: "assign_task" }, catalog, new Set(["assign_task"])).ok,
    true,
    "a rewrite keeps its own name",
  );
});

test("validateInputSchema caps size and depth and refuses $ref", () => {
  assert.equal(validateInputSchema({ type: "object", properties: {} }).ok, true);
  const wide = {
    type: "object",
    properties: { note: { type: "string", description: "x".repeat(MAX_SCHEMA_BYTES) } },
  };
  assert.match(problems(validateInputSchema(wide)), /over \d+ bytes/);
  let deep: Record<string, unknown> = { type: "string" };
  for (let i = 0; i <= MAX_SCHEMA_DEPTH; i += 1)
    deep = { type: "object", properties: { inner: deep } };
  assert.match(problems(validateInputSchema(deep)), /nested deeper than/);
  assert.match(
    problems(validateInputSchema({ type: "object", properties: { q: { $ref: "#/x" } } })),
    /\$ref is not allowed/,
  );
  assert.match(
    problems(validateInputSchema({ type: "object", required: ["ghost"] })),
    /required names ghost/,
  );
});

test("checkProposal refuses two crafted tools of one name and a searchable text past the cap", () => {
  assert.equal(checkProposal([source], rewrite([crafted()]), catalog).ok, true);
  const twins = checkProposal([source], rewrite([crafted(), crafted()]), catalog);
  assert.match(problems(twins), /two crafted tools are both named find_task/);
  const long = checkProposal(
    [source],
    rewrite([crafted({ searchableDescription: "w ".repeat(MAX_SEARCHABLE_CHARS) })]),
    catalog,
  );
  assert.match(problems(long), /searchable description is over/);
  const blank = checkProposal([source], rewrite([crafted({ description: "  " })]), catalog);
  assert.match(problems(blank), /description is empty/);
});
