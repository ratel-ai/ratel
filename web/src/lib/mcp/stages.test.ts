import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleOperations } from "@/lib/mcp/operations";
import { STAGE_META_KEY, stageMeta, TOOL_STAGES } from "@/lib/mcp/stages";
import { isLineageStage } from "@/lib/views/lineage/types";

const published = ["whoami", ...assembleOperations().map((operation) => operation.id)];

test("every published tool has a stage entry, so a new tool cannot skip the decision", () => {
  for (const id of published) {
    assert.ok(
      id in TOOL_STAGES,
      `${id} has no entry in TOOL_STAGES (lib/mcp/stages.ts); give it a stage or null`,
    );
  }
});

test("the stage map names no tool that does not exist", () => {
  for (const id of Object.keys(TOOL_STAGES)) {
    assert.ok(published.includes(id), `${id} is in TOOL_STAGES but is not a tool`);
  }
});

test("every stage is one of the four, and each stage has tools", () => {
  const stages = Object.values(TOOL_STAGES).filter((stage) => stage !== null);
  for (const stage of stages) assert.ok(isLineageStage(stage), `${stage} is not a stage`);
  assert.deepEqual([...new Set(stages)].sort(), ["improve", "insights", "monitor", "ship"]);
});

test("the loop walks Monitor → Insights → Improve → Ship with these tools", () => {
  assert.equal(TOOL_STAGES.list_traces, "monitor");
  assert.equal(TOOL_STAGES.list_insights, "insights");
  assert.equal(TOOL_STAGES.get_fix, "improve");
  assert.equal(TOOL_STAGES.run_eval, "improve");
  assert.equal(TOOL_STAGES.create_experiment, "improve");
  assert.equal(TOOL_STAGES.mark_fix_shipped, "ship");
});

test("the stage is published as tool metadata, and absent outside the loop", () => {
  assert.deepEqual(stageMeta("list_insights"), { [STAGE_META_KEY]: "insights" });
  assert.deepEqual(stageMeta("whoami"), {});
});
