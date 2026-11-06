import assert from "node:assert/strict";
import { test } from "node:test";
import type { ParsedTraceEvent } from "@/lib/ingest/trace-events/parse";
import {
  RUNTIME_DUPLICATE_WINDOW_MS,
  runtimeInvokeProbe,
  withoutRuntimeDuplicates,
} from "./runtime-duplicates";

const AT = Date.UTC(2026, 8, 30, 12);

function row(
  type: string,
  toolId: string | null,
  sessionId: string,
  offsetMs = 0,
): ParsedTraceEvent {
  return { type, toolId, sessionId, occurredAt: new Date(AT + offsetMs) } as ParsedTraceEvent;
}

test("the probe spans the batch's sessions, tools and times, widened by the window", () => {
  const probe = runtimeInvokeProbe([
    row("invoke_end", "find_task", "s-2", 0),
    row("invoke_error", "assign_task", "s-1", 30_000),
    row("otlp_model_call", null, "s-3", 90_000),
  ]);
  assert.deepEqual(probe, {
    sessionIds: ["s-1", "s-2"],
    toolIds: ["assign_task", "find_task"],
    from: new Date(AT - RUNTIME_DUPLICATE_WINDOW_MS),
    to: new Date(AT + 30_000 + RUNTIME_DUPLICATE_WINDOW_MS),
  });
});

test("no tool rows, no probe", () => {
  assert.equal(runtimeInvokeProbe([row("otlp_model_call", null, "s-1")]), null);
});

test("only a same-session, same-tool SDK invoke within the window drops a tool row", () => {
  const rows = [
    row("invoke_end", "find_task", "s-1"),
    row("invoke_end", "find_task", "s-2"),
    row("invoke_end", "assign_task", "s-1", 20_000),
    row("otlp_model_call", null, "s-1"),
  ];
  const kept = withoutRuntimeDuplicates(rows, [
    { sessionId: "s-1", toolId: "find_task", at: new Date(AT + 5_000) },
    { sessionId: "s-1", toolId: "assign_task", at: new Date(AT + 26_000) },
  ]);
  assert.deepEqual(
    kept.map((r) => [r.type, r.toolId, r.sessionId]),
    [
      ["invoke_end", "find_task", "s-2"],
      ["invoke_end", "assign_task", "s-1"],
      ["otlp_model_call", null, "s-1"],
    ],
  );
});

test("without SDK invokes every row is kept", () => {
  const rows = [row("invoke_end", "find_task", "s-1")];
  assert.deepEqual(withoutRuntimeDuplicates(rows, []), rows);
});
