import assert from "node:assert/strict";
import { test } from "node:test";
import { firstTraceOf, sampledTurnIds, TURNS_TRIED } from "./turn-traces";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

test("sampled turns drop malformed ids before taking the first few, so junk cannot crowd out real turns", () => {
  const good = Array.from({ length: TURNS_TRIED + 2 }, (_, i) => id(i));
  const evidence = { turnIds: ["not-a-uuid", 42, null, ...good] };
  assert.deepEqual(sampledTurnIds(evidence), good.slice(0, TURNS_TRIED));
  assert.deepEqual(sampledTurnIds({}), []);
  assert.deepEqual(sampledTurnIds(null), []);
  assert.deepEqual(sampledTurnIds({ turnIds: "x" }), []);
});

test("the first trace follows the turns' order, skipping turns with none", () => {
  const traces = new Map([
    [id(2), "trace-b"],
    [id(3), "trace-c"],
  ]);
  assert.equal(firstTraceOf([id(1), id(3), id(2)], traces), "trace-c");
  assert.equal(firstTraceOf([id(1)], traces), null);
  assert.equal(firstTraceOf([], traces), null);
});
