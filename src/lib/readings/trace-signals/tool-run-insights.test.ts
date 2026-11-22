import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_FLOORS } from "./signals/catalog";
import { createWorkflowCollector } from "./signals/workflow-run";
import {
  TOOL_RUN_MINING,
  toolRunInsightsEnabled,
  toolRunInsightsForProject,
  workflowMiningFor,
} from "./tool-run-insights";
import { wfTurn } from "./workflows/test-fixtures";

/**
 * RC-725: a small project (an MCP server, a coding agent's own tools) has too
 * few multi-tool runs for the default support floor of 10, so Tasks stays
 * empty. With `cloud-tool-run-insights` on for the project, mining uses
 * {@link TOOL_RUN_MINING}. The runs below are "Beluga - MCP" in prod on
 * 2026-11-17 (list_traces, distinct tools per run, in order): 40 runs, 18 of
 * them with two tools or more, 0 tasks.
 *
 * Owned (ADR-0030): the flag cases are the `FF_TOOL_RUN_INSIGHTS` env
 * switch's, not the flag service's.
 */

const BELUGA_RUNS: string[][] = [
  ["task_attach_proof", "task_brief_edit"],
  ["plan_message_task"],
  ["task_get", "task_update", "write_report", "task_attach_proof", "task_brief_edit"],
  ["plan_message_task"],
  [
    "task_get",
    "task_update",
    "send_to_chat",
    "wait_for_chat",
    "task_attach_proof",
    "task_brief_edit",
  ],
  ["task_define", "task_update", "task_brief_edit"],
  ["task_update"],
  ["task_define", "task_update", "task_brief_edit"],
  ["task_define", "task_update"],
  ["task_define", "task_update"],
  ["task_create", "task_update", "task_note"],
  ["task_attach_proof"],
  ["task_note"],
  ["task_brief_edit"],
  ["task_attach_proof"],
  ["task_attach_proof"],
  ["task_attach_proof"],
  ["task_attach_proof"],
  ["task_update", "task_brief_edit", "task_attach_proof"],
  ["task_attach_proof"],
  ["task_attach_proof"],
  ["task_define", "task_attach_proof", "task_update", "task_brief_edit"],
  ["task_define"],
  ["task_define", "task_update", "task_brief_edit"],
  ["task_define"],
  ["task_define"],
  ["task_define"],
  ["task_note"],
  ["task_define", "task_update", "task_brief_edit"],
  ["task_note"],
  ["send_chat", "task_note", "task_create"],
  ["phone_status", "phone_screenshot", "phone_screen"],
  ["task_brief_edit"],
  ["send_chat"],
  ["task_brief_edit", "task_note"],
  ["list_work"],
  ["list_work"],
  ["task_update", "task_brief_edit"],
  ["task_create", "task_relate"],
  ["task_define", "task_update", "task_brief_edit"],
];

function tasksOf(mining?: Parameters<typeof createWorkflowCollector>[3]) {
  const collector = createWorkflowCollector(undefined, DEFAULT_FLOORS, undefined, mining);
  for (const tools of BELUGA_RUNS) collector.collect(wfTurn(tools, { turnSource: "otlp" }));
  return collector
    .finish([])
    .stored.items.map((item) => ({ core: [...item.coreTools], runs: item.runs }));
}

test("default mining: Beluga's 18 multi-tool runs make no task (support floor 10)", () => {
  assert.deepEqual(tasksOf(), []);
});

test("tool-run mining: the same runs make the task_define + task_update task", () => {
  const tasks = tasksOf(TOOL_RUN_MINING);
  assert.ok(tasks.length >= 1, "at least one task");
  assert.deepEqual(tasks[0]!.core, ["task_define", "task_update"]);
  assert.ok(tasks[0]!.runs >= 7, `runs ${tasks[0]!.runs}`);
  assert.ok(
    tasks.some((task) => task.core.includes("task_attach_proof")),
    JSON.stringify(tasks),
  );
});

test("workflowMiningFor: FF_TOOL_RUN_INSIGHTS on gives the tool-run config; off or unset gives none", async () => {
  const org = { id: "org-a" };
  assert.deepEqual(
    await workflowMiningFor("p-on", org, { FF_TOOL_RUN_INSIGHTS: "1" }),
    TOOL_RUN_MINING,
  );
  assert.equal(await workflowMiningFor("p-off", org, { FF_TOOL_RUN_INSIGHTS: "0" }), null);
});

test("without the switch, the flag is off (tests and local runs read as before)", async () => {
  assert.equal(await workflowMiningFor("p-unset", "org-a", {}), null);
  assert.equal(await toolRunInsightsEnabled("p-unset", undefined, {}), false);
  assert.equal(await toolRunInsightsForProject("p-unset", {}), false);
  assert.equal(await toolRunInsightsForProject("p-on", { FF_TOOL_RUN_INSIGHTS: "true" }), true);
});
