import assert from "node:assert/strict";
import { test } from "node:test";
import { wfTurn } from "../workflows/test-fixtures";
import { mergePieces } from "./merge";
import { cutTurn } from "./pieces";

test("adjacent pieces of one task merge across traces, but not across an unplaced piece or another session", () => {
  const turns = [0, 1, 2, 3, 4, 5].map((i) => ({
    ...wfTurn(["a"], { startMs: i * 3000 }),
    sessionId: i === 5 ? "other" : "session",
  }));
  const pieces = turns.flatMap(cutTurn);
  const placement = new Map(pieces.map((p, i) => [p.id, i === 3 ? null : "task"]));
  const segments = mergePieces(pieces.toReversed(), placement);
  assert.equal(segments.length, 3);
  assert.deepEqual(
    segments[1]!.turnIds,
    turns.slice(0, 3).map((t) => t.id),
  );
  assert.equal(segments[1]!.startTurnId, turns[0]!.id);
  assert.equal(segments[1]!.endTurnId, turns[2]!.id);
});
