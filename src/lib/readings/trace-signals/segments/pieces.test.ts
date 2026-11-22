import assert from "node:assert/strict";
import { test } from "node:test";
import { wfTurn } from "../workflows/test-fixtures";
import { cutTurn } from "./pieces";

test("user messages split a turn at their step ordinals", () => {
  const turn = wfTurn(["ask", "a", "ask", "b", "ask", "c"]);
  turn.steps = turn.steps.map((step, i) => ({
    ...step,
    ordinal: i + 1,
    ...(i % 2 === 0 ? { kind: "user_message" as const } : {}),
  }));
  const pieces = cutTurn(turn);
  assert.deepEqual(
    pieces.map((p) => [p.startOrdinal, p.endOrdinal]),
    [
      [1, 2],
      [3, 4],
      [5, 6],
    ],
  );
  assert.equal(new Set(pieces.map((p) => p.id)).size, 3);
  assert.deepEqual(
    pieces[1]!.steps.map((s) => s.targetId),
    ["ask", "b"],
  );
});

test("a turn without user messages is one piece", () => {
  const turn = wfTurn(["a", "b"]);
  const pieces = cutTurn(turn);
  assert.equal(pieces.length, 1);
  assert.deepEqual(pieces[0]!.steps, turn.steps);
  assert.equal(pieces[0]!.turnId, turn.id);
});

test("Docs setup steps stay with the first user message instead of forming an extra task", () => {
  const turn = wfTurn([
    "setup",
    "ask-one",
    "model-one",
    "ask-two",
    "model-two",
    "ask-three",
    "model-three",
  ]);
  turn.steps = turn.steps.map((step, i) => ({
    ...step,
    ordinal: i + 1,
    kind: i === 0 ? "code" : i % 2 === 1 ? "user_message" : "model_call",
  }));
  assert.deepEqual(
    cutTurn(turn).map((piece) => [piece.startOrdinal, piece.endOrdinal]),
    [
      [1, 3],
      [4, 5],
      [6, 7],
    ],
  );
});
