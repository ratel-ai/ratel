import assert from "node:assert/strict";
import { test } from "node:test";
import type { TopicTurn } from "@/lib/readings/topics/asks";
import { derivedAsks, toolPathAsk } from "@/lib/readings/topics/derived-asks";

function turn(id: string, tools: string[], workflowId: string | null = null): TopicTurn {
  return {
    id,
    sessionId: `s-${id}`,
    endUserKey: null,
    turnSource: "otlp",
    startedAt: new Date(0),
    endedAt: new Date(1),
    endedBy: null,
    calls: tools.map((tool) => ({ tool, outcome: "ok" as const })),
    firstSearch: null,
    workflowId,
  };
}

test("toolPathAsk: distinct tools in first-call order, MCP server prefix dropped, humanized", () => {
  assert.equal(
    toolPathAsk([
      "mcp__beluga_board__task_define",
      "mcp__beluga_board__task_update",
      "mcp__beluga_board__task_define",
    ]),
    "task define, task update",
  );
  assert.equal(
    toolPathAsk(["listTraces", "get-trace", "skill:review.failures"]),
    "list traces, get trace, review failures",
  );
  assert.equal(toolPathAsk(["a", "b", "c", "d", "e", "f"]), "a, b, c, d and 2 more");
  assert.equal(toolPathAsk([]), null);
});

test("derivedAsks: only turns with calls and no raw ask; the task's name wins over the tool path", () => {
  const turns = [
    turn("t1", ["list_traces", "get_trace"]),
    turn("t2", ["get_trace"], "wf_1"),
    turn("t3", ["x"]),
    turn("t4", []),
    turn("t5", ["y"], "wf_unlabelled"),
  ];
  const out = derivedAsks(
    turns,
    new Set(["t3"]),
    new Map([["wf_1", { name: "Review failing traces" }]]),
  );
  assert.deepEqual(
    [...out],
    [
      ["t1", { text: "list traces, get trace", source: "derived" }],
      ["t2", { text: "Review failing traces", source: "derived" }],
      ["t5", { text: "y", source: "derived" }],
    ],
  );
});
