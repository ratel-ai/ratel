import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolCraftProposalRow } from "@/lib/synthesis/tool-crafter/schema";
import {
  type ToolCrafterOperationDeps,
  toolCrafterOperations,
  toolCrafterWriteOperations,
} from "./tool-crafter";

/** Words the product never shows, MCP descriptions included (DESIGN.md, The product's nouns). */
const FORBIDDEN = /tool craft|suggestion|proposal|workflow|\bcraft(s|ed)?\b/i;

const ROW = {
  id: "6f1c1c4e-0000-4000-8000-000000000001",
  runId: "r1",
  projectId: "p1",
  kind: "merge_tools",
  status: "pending",
  sourceToolIds: ["find_task", "assign_task"],
  sourceDefinitions: [],
  crafted: [
    {
      name: "find_and_assign_task",
      description: "",
      searchableDescription: "",
      inputSchema: {},
      outputNotes: null,
      dispatch: [],
    },
  ],
  hiddenToolIds: [],
  rationale: "Always run together.",
  details: "",
  expectedEffect: "",
  migrationNotes: "",
  evidence: {},
  backtest: null,
  createdAt: new Date("2026-10-20T12:00:00.000Z"),
  updatedAt: new Date("2026-10-20T12:00:00.000Z"),
} as unknown as ToolCraftProposalRow;

const deps: ToolCrafterOperationDeps = {
  latestRun: async () => null,
  listProposals: async () => [ROW],
  getProposal: async () => ROW,
  findInFlightJob: async () => null,
  enqueueJob: async () => ({ id: "job-1" }) as never,
};

const ctx = { projectId: "p1" } as never;

test("the drafted-fix tools keep their ids and are described as fixes", () => {
  const operations = [...toolCrafterOperations(deps), ...toolCrafterWriteOperations(deps)];
  assert.deepEqual(
    operations.map((operation) => operation.id),
    ["list_tool_crafts", "get_tool_craft", "generate_tool_crafts"],
  );
  for (const operation of operations) {
    assert.match(`${operation.title} ${operation.description}`, /\bfix(es)?\b/i, operation.id);
    assert.doesNotMatch(operation.title, FORBIDDEN, operation.id);
    assert.doesNotMatch(operation.description, FORBIDDEN, operation.id);
  }
});

test("each listed fix carries the id Fixes opens it by and its plain kind", async () => {
  const [list, get] = toolCrafterOperations(deps);
  const listed = (await list!.execute(ctx, { projectId: "p1", limit: 10 } as never)) as {
    data: { crafts: { fixId: string; kindLabel: string }[] };
    hint?: string;
  };
  assert.equal(listed.data.crafts[0]?.fixId, "craft:6f1c1c4e-0000-4000-8000-000000000001");
  assert.equal(listed.data.crafts[0]?.kindLabel, "Merge tools");
  assert.doesNotMatch(listed.hint ?? "", FORBIDDEN);
  const one = (await get!.execute(ctx, { projectId: "p1", craftId: ROW.id } as never)) as {
    data: { craft: { fixId: string; kindLabel: string } };
    hint?: string;
  };
  assert.equal(one.data.craft.fixId, "craft:6f1c1c4e-0000-4000-8000-000000000001");
  assert.equal(one.data.craft.kindLabel, "Merge tools");
  assert.doesNotMatch(one.hint ?? "", FORBIDDEN);
});
