import assert from "node:assert/strict";
import { test } from "node:test";
import type { TurnFixture } from "@/lib/ledger/test-support";
import type { StepDraft } from "@/lib/ledger/types";
import {
  actionClassOf,
  isProbe,
  toolName,
} from "@/lib/readings/trace-signals/hallucinations/action-class";
import { claimsCompletion } from "@/lib/readings/trace-signals/hallucinations/claims";
import {
  type DetectInput,
  detectHallucinations,
} from "@/lib/readings/trace-signals/hallucinations/detect";
import { errorShapeOf } from "@/lib/readings/trace-signals/hallucinations/error-shapes";
import { fresh, signalTurns } from "@/lib/readings/trace-signals/signals/test-fixtures";

/** One fixture turn's steps. */
const stepsOf = (fixture: TurnFixture): readonly StepDraft[] => signalTurns([fixture])[0]!.steps;

/** Invoke steps of a tool, in order. */
const callsOf = (steps: readonly StepDraft[], tool: string) =>
  steps.filter((step) => step.kind === "invoke" && step.targetId === tool);

function detect(steps: readonly StepDraft[], over: Partial<DetectInput> = {}) {
  const found = detectHallucinations({
    steps,
    errors: new Map(),
    requested: new Map(),
    noSuchTool: new Set(),
    catalog: null,
    reply: null,
    ...over,
  });
  return found.map((finding) => [
    finding.kind,
    finding.toolId,
    finding.requestedToolId,
    finding.repeats,
  ]);
}

const errorsFor = (steps: readonly StepDraft[], tool: string, text: string) =>
  new Map(
    callsOf(steps, tool)
      .filter((step) => step.outcome === "error")
      .map((step) => [step.endTraceEventId ?? step.traceEventId, text]),
  );

test("a tool's verb is read from every part of its name, the tool's own part first, and from runs of capitals", () => {
  assert.deepEqual(
    [
      "create.issue",
      "users.create",
      "issues/delete",
      "HTTPGet",
      "getHTTPStatus",
      "XMLUpload",
      // The server's part names no action; the tool's own part wins over it.
      "notify__list_users",
      "github__get_issue",
    ].map(actionClassOf),
    ["create", "create", "remove", "read", "read", "create", "read", "read"],
  );
  // Comparing names is unchanged: the tool's own part, lowercased.
  assert.deepEqual(["create.issue", "HTTPGet"].map(toolName), ["issue", "httpget"]);
});

test("a tool's action is its first known verb; a name without one has none", () => {
  assert.deepEqual(
    [
      "get_task",
      "entity_lookup",
      "create_document",
      "post_progress_comment",
      "add_task_comment",
      "update_tasks_batch",
      "create_tasks_batch",
      "archive_board",
      "sync_session_workflow",
      "brain",
    ].map(actionClassOf),
    ["read", "read", "create", "create", "create", "change", "create", "remove", "change", null],
  );
  assert.deepEqual(["mcp__acme__Get_Task", "acme.get_task", "skill:report"].map(toolName), [
    "get_task",
    "get_task",
    "report",
  ]);
  assert.deepEqual(
    ["search_tasks", "filter_tasks", "entity_lookup", "get_document_content"].map(isProbe),
    [true, true, false, false],
  );
});

test("an error's shape: a tool that does not exist, a record that does not, the values it takes; anything that may be access or a limit is nothing", () => {
  const shape = (text: string) => errorShapeOf(text)?.shape ?? null;
  assert.equal(shape("Task not found"), "unknown_reference");
  assert.equal(
    shape('No teammate matched "ozi@example.com" in this workspace.'),
    "unknown_reference",
  );
  assert.equal(
    shape(
      "Invalid statusKey or statusId — status not available in the destination project. Available: To Do (ctdE2eb), In Progress (ctdFZAn), Done (ctdItuk).",
    ),
    "value_not_allowed",
  );
  assert.equal(shape("Unknown tool: merge_tasks"), "unknown_tool");
  assert.equal(
    shape('{"code":"tool_not_found","message":"Tool merge_tasks does not exist"}'),
    "unknown_tool",
  );
  // A missing record and a hidden one are reported the same way.
  assert.equal(shape("GitHub PR not found. Check the URL and ensure you have access."), null);
  assert.equal(shape("Requested item was not found or is not accessible."), null);
  assert.equal(shape("Project not found or not accessible"), null);
  // The caller's shape, the tool's own, a limit and a setup problem say nothing about what was made up.
  for (const text of [
    "validation_failed",
    "operation_failed",
    "Internal server error",
    "Description must be 10000 characters or less",
    "Parent task creation returned no task",
    "Only Acme-authored documents can be updated via MCP",
    "No valid GitHub token available. Please connect your GitHub account.",
    "",
  ]) {
    assert.equal(shape(text), null, text);
  }
});

test("an error a runtime wrapped is read after its wrapper: naming the tool that ran is not saying it does not exist", () => {
  const shape = (text: string) => errorShapeOf(text)?.shape ?? null;
  assert.equal(
    shape("Error executing tool get_issue: Issue ENG-999 not found"),
    "unknown_reference",
  );
  assert.equal(shape("Tool execution failed: record does not exist"), "unknown_reference");
  assert.equal(
    shape("Error calling tool set_status: Invalid status. Must be one of: open, closed"),
    "value_not_allowed",
  );
  assert.equal(
    shape("Error executing tool merge_tasks: Unknown tool: merge_tasks"),
    "unknown_tool",
  );
  // The tool word near "not found" is not enough: the error must name a tool as missing.
  assert.equal(shape("The function timed out; the upstream host was not found"), null);
  assert.equal(shape("Tool get_issue failed: upstream returned 500"), null);
  // A tool named as missing, in the words runtimes use.
  assert.equal(shape("Tool merge_tasks not found"), "unknown_tool");
  assert.equal(shape("Function 'merge_tasks' is not registered"), "unknown_tool");
  assert.equal(shape("No such tool: merge_tasks"), "unknown_tool");
});

test("a reply claims completion when it says done and admits nothing", () => {
  for (const reply of [
    "Done. RS-202 is closed and Ada has been notified.",
    "Both PRs are linked to CACHE-12.",
    "C'est fait : OPS-19 est fermée et Léa a été prévenue.",
    "Erledigt: INF-88 liegt im Projekt Infra.",
    "He creado 5 tareas a partir del documento.",
    'Archived the project "Onboarding v2".',
    "I've created the task.",
  ]) {
    assert.equal(claimsCompletion(reply), true, reply);
  }
  for (const reply of [
    "I couldn't find that task.",
    "Created the task, but the comment failed.",
    "Which day should it repeat on?",
    "You have 3 overdue tasks.",
    "Sorry, I only tagged the first page.",
    "",
    null,
  ]) {
    assert.equal(claimsCompletion(reply), false, String(reply));
  }
});

test("ordinary words do not cancel a claim; questions, conditions and instructions are no claim", () => {
  for (const reply of [
    "I've created the issue ENG-12 and assigned it to you.",
    "Done. The issue is closed.",
    "I sent it, no problem!",
    "Done, but let me know if you want a different label.",
    "I've created the task. Anything else?",
    "Only one task matched, and I've closed it.",
  ]) {
    assert.equal(claimsCompletion(reply), true, reply);
  }
  for (const reply of [
    "There was a problem creating the issue.",
    "I ran into an issue while updating the record.",
    "I could only create two of the three tasks.",
    "Created the task, but the label was not added.",
    "Should I have created it in the other project?",
    "Once I have updated the record I'll confirm. Shall I go ahead?",
    "If you want, I've set up a draft you can review first?",
    "Complete the form and I will send it.",
    "Tamam, şimdi bakıyorum.",
  ]) {
    assert.equal(claimsCompletion(reply), false, reply);
  }
});

test("asked for one tool, ran another: a reroute, or a changed action when the tool that ran does something else", () => {
  const steps = stepsOf(
    fresh()
      .invoke("entity_lookup")
      .invoke("create_document")
      .error("create_document")
      .invoke("create_document")
      .error("create_document"),
  );
  const requested = new Map([
    [callsOf(steps, "entity_lookup")[0]!.traceEventId, "get_task"],
    ...callsOf(steps, "create_document").map(
      (step) => [step.endTraceEventId ?? step.traceEventId, "get_document"] as const,
    ),
  ]);
  assert.deepEqual(
    detect(steps, { requested, errors: errorsFor(steps, "create_document", "validation_failed") }),
    [
      ["tool_rerouted", "entity_lookup", "get_task", 1],
      // Two failed tries of one reroute are one finding, and their validation error is not a second one.
      ["tool_action_changed", "create_document", "get_document", 2],
    ],
  );
});

test("a catalog's names compare without case or namespace, like the requested name", () => {
  const steps = stepsOf(fresh().invoke("entity_lookup"));
  const lookup = callsOf(steps, "entity_lookup")[0]!.traceEventId;
  // The catalog holds camelCase names; the agent asked for the same tool with a server prefix.
  assert.deepEqual(
    detect(steps, {
      requested: new Map([[lookup, "linear__createIssue"]]),
      catalog: new Set(["createIssue", "entity_lookup"]),
    }),
    [],
  );
  // A name the catalog does not hold is still a reroute.
  assert.equal(
    detect(steps, {
      requested: new Map([[lookup, "linear__deleteIssue"]]),
      catalog: new Set(["createIssue", "entity_lookup"]),
    }).length,
    1,
  );
});

test("a requested name the catalog holds, or one that only differs by namespace or case, is not a reroute", () => {
  const steps = stepsOf(fresh().invoke("entity_lookup").invoke("update_task"));
  const lookup = callsOf(steps, "entity_lookup")[0]!.traceEventId;
  const update = callsOf(steps, "update_task")[0]!.traceEventId;
  assert.deepEqual(
    detect(steps, {
      requested: new Map([[lookup, "get_task"]]),
      catalog: new Set(["get_task", "entity_lookup"]),
    }),
    [],
  );
  assert.deepEqual(detect(steps, { requested: new Map([[update, "acme__Update_Task"]]) }), []);
  // The agent's own string is kept only when it is shaped like an id.
  assert.deepEqual(
    detect(steps, { requested: new Map([[lookup, "the task about the launch, please"]]) }),
    [],
  );
});

test("a failure streak is one finding by what its error says; a search that finds nothing is an answer", () => {
  const steps = stepsOf(
    fresh()
      .invoke("entity_lookup")
      .error("entity_lookup")
      .invoke("entity_lookup")
      .error("entity_lookup")
      .invoke("update_task")
      .error("update_task")
      .invoke("search_tasks")
      .error("search_tasks"),
  );
  const errors = new Map([
    ...errorsFor(steps, "entity_lookup", "Task not found"),
    ...errorsFor(steps, "update_task", "Invalid statusKey. Available: To Do, Done"),
    ...errorsFor(steps, "search_tasks", "Task not found"),
  ]);
  assert.deepEqual(detect(steps, { errors }), [
    ["unknown_reference", "entity_lookup", null, 2],
    ["value_not_allowed", "update_task", null, 1],
  ]);
  // No error text kept (pruned after 30 days): nothing to stand on.
  assert.deepEqual(detect(steps), []);
});

test("a tool that does not exist: named by the error, or by the result of a call that worked; never one the catalog holds", () => {
  const failed = stepsOf(fresh().invoke("merge_tasks").error("merge_tasks"));
  const errors = errorsFor(failed, "merge_tasks", "Unknown tool: merge_tasks");
  assert.deepEqual(detect(failed, { errors }), [["unknown_tool", "merge_tasks", null, 1]]);
  assert.deepEqual(detect(failed, { errors, catalog: new Set(["merge_tasks"]) }), []);

  const worked = stepsOf(fresh().invoke("merge_tasks"));
  assert.deepEqual(
    detect(worked, { noSuchTool: new Set([callsOf(worked, "merge_tasks")[0]!.traceEventId]) }),
    [["unknown_tool", "merge_tasks", null, 1]],
  );
});

test("said done after an acting call failed and nothing of its kind worked after it", () => {
  const reply = "Done. RS-202 is closed and Ada has been notified.";
  const partial = stepsOf(
    fresh().invoke("update_task").invoke("add_task_comment").error("add_task_comment"),
  );
  assert.deepEqual(detect(partial, { reply }), [
    ["claimed_done_after_failure", "add_task_comment", null, 1],
  ]);
  // The same tool worked on the next try: the claim is true.
  const recovered = stepsOf(
    fresh().invoke("create_task").error("create_task").invoke("create_task"),
  );
  assert.deepEqual(detect(recovered, { reply: "Erledigt: INF-88 liegt im Projekt Infra." }), []);
  // A failed read is not work left undone, and a reply that owns up is not a false report.
  const read = stepsOf(
    fresh().invoke("entity_lookup").error("entity_lookup").invoke("update_task"),
  );
  assert.deepEqual(detect(read, { reply }), []);
  assert.deepEqual(detect(partial, { reply: "RS-202 is closed, but I couldn't notify Ada." }), []);
  assert.deepEqual(detect(partial), [], "no reply captured: nothing claimed");
});

test("in a streak of mixed errors the finding sits on the try that shows it", () => {
  const steps = stepsOf(
    fresh()
      .invoke("update_task")
      .error("update_task")
      .invoke("update_task")
      .error("update_task")
      .invoke("update_task")
      .error("update_task"),
  );
  const failed = callsOf(steps, "update_task");
  const errors = new Map([
    [failed[0]!.endTraceEventId ?? failed[0]!.traceEventId, "validation_failed"],
    [
      failed[1]!.endTraceEventId ?? failed[1]!.traceEventId,
      "Invalid statusKey. Available: To Do, Done",
    ],
    [
      failed[2]!.endTraceEventId ?? failed[2]!.traceEventId,
      "Invalid statusKey. Available: To Do, Done",
    ],
  ]);
  const found = detectHallucinations({
    steps,
    errors,
    requested: new Map(),
    noSuchTool: new Set(),
    catalog: null,
    reply: null,
  });
  assert.deepEqual(
    found.map((finding) => [finding.kind, finding.stepOrdinal, finding.repeats]),
    [["value_not_allowed", failed[1]!.ordinal, 2]],
  );
});
