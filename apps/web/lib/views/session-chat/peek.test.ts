import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chatPeekId,
  parseChatPeek,
  sessionPageView,
  sessionTraceHref,
  traceViewTurn,
} from "./peek";

test("peek ids round-trip", () => {
  for (const id of ["ask:1", "reply:3", "work:12", "step:7"])
    assert.equal(chatPeekId(parseChatPeek(id)!), id);
  assert.deepEqual(parseChatPeek("work:2"), { kind: "work", turnIndex: 2 });
  assert.deepEqual(parseChatPeek("step:9"), { kind: "step", stepIndex: 9 });
});

test("anything else is no peek", () => {
  for (const id of [
    null,
    undefined,
    "",
    "work:0",
    "work:-1",
    "work:x",
    "turn:1",
    "step:1:2",
    "step:99999999999999999999",
  ])
    assert.equal(parseChatPeek(id), null);
});

test("the page view: the chat unless ?view=steps or ?view=trace (session replay on is the page's own gate)", () => {
  assert.equal(sessionPageView(undefined), "chat");
  assert.equal(sessionPageView("chat"), "chat");
  assert.equal(sessionPageView("steps"), "steps");
  assert.equal(sessionPageView("trace"), "trace");
  assert.equal(sessionPageView("nope"), "chat");
});

test("a repeated ?view= reads as its first value (review finding session F2)", () => {
  assert.equal(sessionPageView(["steps", "steps"]), "steps");
  assert.equal(sessionPageView(["steps", "chat"]), "steps");
  assert.equal(sessionPageView(["trace", "steps"]), "trace");
  assert.equal(sessionPageView([]), "chat");
});

test("the Trace view's turn: the asked turn when the session has it, else the last turn", () => {
  assert.equal(traceViewTurn("2", [1, 2, 3]), 2);
  assert.equal(traceViewTurn(["3", "1"], [1, 2, 3]), 3);
  assert.equal(traceViewTurn(undefined, [1, 2, 3]), 3);
  assert.equal(traceViewTurn("9", [1, 2, 3]), 3);
  assert.equal(traceViewTurn("x", [1, 2, 3]), 3);
  assert.equal(traceViewTurn("1", []), null);
});

test("the Trace view's link carries the turn and, when picked, the run", () => {
  assert.equal(
    sessionTraceHref("p 1", "s/1", 2),
    "/project/p%201/sessions/s%2F1?view=trace&turn=2",
  );
  assert.equal(
    sessionTraceHref("p", "s", 2, "abc"),
    "/project/p/sessions/s?view=trace&turn=2&trace=abc",
  );
});
