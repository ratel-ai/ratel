import assert from "node:assert/strict";
import { test } from "node:test";
import {
  initialViewState,
  inputProject,
  pickBinding,
  readToolResult,
  type ViewEvent,
  type ViewState,
  viewReducer,
  withProject,
} from "./state";
import { errorResult, okResult } from "./types";

const run = (events: ViewEvent[], from: ViewState = initialViewState) =>
  events.reduce(viewReducer, from);
const connected = run([{ type: "connected", toolName: "list_traces", theme: "light" }]);

test("connecting to a host waits for the call, with its tool and theme", () => {
  assert.equal(connected.status, "waiting");
  assert.equal(connected.toolName, "list_traces");
  assert.equal(connected.theme, "light");
});

test("partial input shows the skeleton and keeps the latest arguments", () => {
  const state = run(
    [
      { type: "input-partial", arguments: { project: "ac" } },
      { type: "input-partial", arguments: { project: "acme" } },
    ],
    connected,
  );
  assert.equal(state.status, "partial");
  assert.deepEqual(state.input, { project: "acme" });
  const full = viewReducer(state, { type: "input", arguments: { project: "acme", limit: 50 } });
  assert.equal(full.status, "waiting");
  assert.deepEqual(full.input, { project: "acme", limit: 50 });
});

test("a result is ready with the Ratel envelope", () => {
  const state = run(
    [{ type: "result", result: okResult({ rows: [1] }, { truncated: true }) }],
    connected,
  );
  assert.equal(state.status, "ready");
  assert.deepEqual(state.result, { ok: true, data: { rows: [1] }, truncated: true });
  assert.equal(state.error, null);
});

test("an ok:false result is an error with the server's code and message", () => {
  const state = run(
    [{ type: "result", result: errorResult("rate_limited", "Slow down.") }],
    connected,
  );
  assert.equal(state.status, "error");
  assert.deepEqual(state.error, { code: "rate_limited", message: "Slow down." });
  assert.equal(state.result, null);
});

test("cancellation before a result is cancelled; after one, the result stays", () => {
  const cancelled = run(
    [
      { type: "input", arguments: {} },
      { type: "cancelled", reason: "stopped" },
    ],
    connected,
  );
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.reason, "stopped");

  const kept = run([{ type: "result", result: okResult([]) }, { type: "cancelled" }], connected);
  assert.equal(kept.status, "ready");
});

test("late partial input does not reopen a settled call", () => {
  const ready = run(
    [
      { type: "result", result: okResult([]) },
      { type: "input-partial", arguments: { x: 1 } },
    ],
    connected,
  );
  assert.equal(ready.status, "ready");
});

test("a result names its tool through sh.ratel/binding when the host did not", () => {
  const result = {
    ...okResult([]),
    _meta: { "sh.ratel/binding": { view: "list", tool: "list_sessions" } },
  };
  const state = run([{ type: "connected" }, { type: "result", result }]);
  assert.equal(state.toolName, "list_sessions");
});

test("a view reads its own model from the result's sh.ratel/view _meta, next to the binding", () => {
  const view = { kind: "session_chat", turns: 3 };
  const result = okResult({ sessionId: "s" }, { view });
  assert.deepEqual(
    result.structuredContent,
    { ok: true, data: { sessionId: "s" } },
    "not in what the model reads",
  );
  assert.ok(!result.content?.[0].text?.includes("session_chat"));
  const state = run(
    [
      {
        type: "result",
        result: {
          ...result,
          _meta: { ...result._meta, "sh.ratel/binding": { view: "replay", tool: "get_session" } },
        },
      },
    ],
    connected,
  );
  assert.deepEqual(state.result, { ok: true, data: { sessionId: "s" }, view });
  assert.equal(state.toolName, "get_session");

  // A tools/call from inside the view (RatelView.callTool) reads the same place.
  const called = readToolResult(result);
  assert.ok(called.ok && called.value.view === view);
});

test("a malformed sh.ratel/view is ignored", () => {
  const read = readToolResult({
    structuredContent: { ok: true, data: 1, view: { kind: "trace" } },
    _meta: { "sh.ratel/view": [1] },
  });
  assert.ok(read.ok);
  assert.deepEqual(
    read.value.view,
    { kind: "trace" },
    "a malformed _meta view leaves the body as it came",
  );
});

test("a host that cannot connect is an error", () => {
  const state = viewReducer(initialViewState, { type: "connect-failed", message: "no parent" });
  assert.equal(state.status, "error");
  assert.equal(state.error?.code, "host_unavailable");
});

test("theme changes from the host apply", () => {
  assert.equal(viewReducer(connected, { type: "theme", theme: "dark" }).theme, "dark");
});

test("results are read from text when a host drops structuredContent", () => {
  const read = readToolResult({
    content: [{ type: "text", text: JSON.stringify({ ok: true, data: { a: 1 } }) }],
  });
  assert.deepEqual(read, { ok: true, value: { ok: true, data: { a: 1 } } });
});

test("an isError result without a Ratel body is a tool error", () => {
  const read = readToolResult({ isError: true, content: [{ type: "text", text: "boom" }] });
  assert.deepEqual(read, { ok: false, error: { code: "tool_error", message: "boom" } });
});

test("the binding is the tool's, or the only one", () => {
  const bindings = [{ tool: "a" }, { tool: "b" }];
  assert.equal(pickBinding(bindings, "b")?.tool, "b");
  assert.equal(pickBinding(bindings, null), null);
  assert.equal(pickBinding([{ tool: "a" }], "zzz")?.tool, "a");
});

test("a view's own call is for the project of the call that rendered it, as a signed-in person's must be", () => {
  const project = inputProject({
    projectId: "3f1c9a52-7d4e-4b8a-9c11-5e2d6f0a8b73",
    windowDays: 7,
  });
  assert.equal(project, "3f1c9a52-7d4e-4b8a-9c11-5e2d6f0a8b73");
  assert.deepEqual(withProject({ what: "health" }, project), {
    what: "health",
    projectId: project,
  });
  // A call that names its own project keeps it (a project list opening one of its rows).
  assert.deepEqual(withProject({ projectId: "other" }, project), { projectId: "other" });
});

test("a call rendered without a project (an API key implies it) adds none", () => {
  assert.equal(inputProject(null), null);
  assert.equal(inputProject({ windowDays: 7 }), null);
  assert.equal(inputProject({ projectId: "" }), null);
  const args = { what: "health" };
  assert.equal(withProject(args, null), args);
});
