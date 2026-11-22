import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assistantText,
  type ChatTurn,
  chatMessages,
  chatTurn,
  chatTurnsFromRuns,
  initialRunView,
  type PlaygroundParam,
  type RunViewState,
  runRequestBody,
} from "../playground-state";
import { manifestTools } from "../tools-state";

/**
 * The chat playground's pure state: one run per user turn, the conversation a
 * turn sends, the assistant text a run ends with, and the run request with the
 * tool settings folded in.
 */

const ended = (patch: Partial<RunViewState>): RunViewState => ({
  ...initialRunView,
  phase: "ended",
  runId: "r1",
  status: "ok",
  ...patch,
});

const okTurn = (user: string, assistant: string | null): ChatTurn => ({
  user,
  runId: "r",
  traceId: null,
  status: "ok",
  assistant,
  error: null,
  tools: [],
});

test("assistantText takes the streamed text, else a string output, else the output's text field", () => {
  assert.equal(assistantText("Hello", "ignored"), "Hello");
  assert.equal(assistantText("", "Plain answer"), "Plain answer");
  assert.equal(assistantText("", { text: "From the field" }), "From the field");
  assert.equal(assistantText("", { answer: 42 }), null);
  assert.equal(assistantText("", null), null);
});

test("chatTurn freezes an ended run as a turn with its reply, trace and tool calls", () => {
  const tool = {
    callId: "c1",
    tool: "searchDocs",
    args: { q: "x" },
    mode: "real",
    result: [],
    done: true,
  };
  const turn = chatTurn("Hi", ended({ text: "Hello", traceId: "t1", tools: [tool] }));
  assert.deepEqual(turn, {
    user: "Hi",
    runId: "r1",
    traceId: "t1",
    status: "ok",
    assistant: "Hello",
    error: null,
    tools: [tool],
  });
});

test("chatTurn makes a failed turn with the server message, or a generic one", () => {
  const failed = chatTurn("Hi", ended({ status: "error", error: "run_failed: try again" }));
  assert.equal(failed.error, "run_failed: try again");
  assert.equal(failed.assistant, null);
  assert.equal(chatTurn("Hi", ended({ status: "error", error: null })).error, "The run failed.");
  assert.equal(chatTurn("Hi", ended({ status: "canceled" })).error, "You canceled this turn.");
  const refused = chatTurn("Hi", { ...initialRunView, error: "Your runner is paused." });
  assert.equal(refused.runId, null);
  assert.equal(refused.error, "Your runner is paused.");
});

test("chatMessages sends the finished turns in order, then the new message, and skips failed turns", () => {
  const failed: ChatTurn = { ...okTurn("Lost", null), status: "error", error: "The run failed." };
  assert.deepEqual(
    chatMessages([okTurn("Hi", "Hello"), failed, okTurn("Only tools", null)], "Next"),
    [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "Only tools" },
      { role: "user", content: "Next" },
    ],
  );
  assert.deepEqual(chatMessages([], "First"), [{ role: "user", content: "First" }]);
});

test("chatTurnsFromRuns rebuilds one session's turns, oldest first, from the runs list", () => {
  const runs = [
    {
      id: "r3",
      sessionId: "s2",
      status: "ok",
      input: { messages: [{ role: "user", content: "Other" }] },
      output: "x",
      error: null,
      traceId: null,
      createdAt: "2026-11-20T10:03:00Z",
    },
    {
      id: "r2",
      sessionId: "s1",
      status: "error",
      input: {
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello" },
          { role: "user", content: "Again" },
        ],
      },
      output: null,
      error: { message: "Boom" },
      traceId: "t2",
      createdAt: "2026-11-20T10:02:00Z",
    },
    {
      id: "r1",
      sessionId: "s1",
      status: "ok",
      input: { messages: [{ role: "user", content: "Hi" }] },
      output: { text: "Hello" },
      error: null,
      traceId: "t1",
      createdAt: "2026-11-20T10:01:00Z",
    },
  ];
  assert.deepEqual(chatTurnsFromRuns(runs, "s1"), [
    {
      user: "Hi",
      runId: "r1",
      traceId: "t1",
      status: "ok",
      assistant: "Hello",
      error: null,
      tools: [],
    },
    {
      user: "Again",
      runId: "r2",
      traceId: "t2",
      status: "error",
      assistant: null,
      error: "Boom",
      tools: [],
    },
  ]);
});

test("runRequestBody merges the tools edits into params and sends the changed tool modes", () => {
  const params: PlaygroundParam[] = [
    { name: "maxTokens", kind: "scalar", type: "int", default: 400 },
    {
      name: "tools",
      kind: "tools",
      default: [
        { name: "searchDocs", description: "Search the docs", hint: "readOnly" },
        { name: "createTicket", description: "Open a ticket", hint: "sideEffect" },
      ],
    },
  ];
  const tools = manifestTools({ params });
  const body = runRequestBody({
    runnerId: "rn",
    sandboxId: "support",
    sessionId: "s1",
    input: { messages: [] },
    params,
    values: { maxTokens: 300 },
    tools,
    toolSettings: {
      searchDocs: { mode: "fake" },
      createTicket: { description: "File a ticket", mode: "real" },
    },
  });
  assert.deepEqual(body, {
    runnerId: "rn",
    sandboxId: "support",
    sessionId: "s1",
    input: { messages: [] },
    params: {
      maxTokens: 300,
      tools: [{ name: "searchDocs" }, { name: "createTicket", description: "File a ticket" }],
    },
    toolModes: { searchDocs: "fake" },
    context: {},
  });
});

test("runRequestBody leaves out an empty session and adds the replay when there is one", () => {
  const body = runRequestBody({
    runnerId: "rn",
    sandboxId: "t",
    sessionId: null,
    input: {},
    params: [],
    values: {},
    tools: [],
    toolSettings: {},
    replay: { sourceTraceId: "tr", arm: "baseline" },
  });
  assert.equal("sessionId" in body, false);
  assert.deepEqual(body.replay, { sourceTraceId: "tr", arm: "baseline" });
  assert.deepEqual(body.toolModes, {});
});
