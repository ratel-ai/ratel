import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTurnPeek, withTurnPeek } from "@/lib/views/traces/turn-peek";

const TURN = "d092d6f1-072a-4416-93b2-1ccf73585ac8";
const CALL = "a02c6f36-70f1-8321-8c8b-0f9d94ccca5f";

test("a turn opened beside a list is added to the list's own address, and read back", () => {
  const search = withTurnPeek("?days=90&open=misread_request", { turnId: TURN, eventId: CALL });
  assert.equal(search, `?days=90&open=misread_request&turn=${TURN}&call=${CALL}`);
  assert.deepEqual(parseTurnPeek({ turn: TURN, call: CALL }), { turnId: TURN, eventId: CALL });
});

test("another turn replaces the one that is open, with its call", () => {
  assert.equal(
    withTurnPeek(`?turn=${CALL}&call=${TURN}`, { turnId: TURN, eventId: null }),
    `?turn=${TURN}`,
  );
});

test("an address without a real turn id opens none", () => {
  assert.equal(parseTurnPeek({}), null);
  assert.equal(parseTurnPeek({ turn: "not-a-turn" }), null);
  assert.deepEqual(parseTurnPeek({ turn: TURN, call: "x" }), { turnId: TURN, eventId: null });
});
