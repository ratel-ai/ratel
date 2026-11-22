import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bitsetOf,
  indicesAndNot,
  intersect,
  popcount,
  popcountAndNot,
  union,
} from "@/lib/readings/trace-signals/workflows/bitset";
import { mineItemsets } from "@/lib/readings/trace-signals/workflows/itemsets";

test("bitset operations", () => {
  const a = bitsetOf(70, [0, 31, 32, 69]);
  const b = bitsetOf(70, [31, 69, 5]);
  assert.equal(popcount(a), 4);
  assert.equal(popcount(intersect(a, b)), 2);
  assert.equal(popcount(union(a, b)), 5);
  assert.equal(popcountAndNot(a, b), 2);
  assert.deepEqual(indicesAndNot(a, b), [0, 32]);
  assert.deepEqual(indicesAndNot(a, bitsetOf(70, [])), [0, 31, 32, 69]);
});

test("Apriori levels: supports, the floor, and subset pruning", () => {
  // Turns 0-9: tools 0,1,2 together; turns 10-14: tools 0,1; tool 3 in turns 0-4 only.
  const size = 15;
  const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
  const tools = [
    bitsetOf(size, range(0, 15)),
    bitsetOf(size, range(0, 15)),
    bitsetOf(size, range(0, 10)),
    bitsetOf(size, range(0, 5)),
  ];
  const lattice = mineItemsets(tools, { floor: 6, maxSize: 8, maxCandidates: 100 });
  assert.deepEqual(
    lattice.levels[1]!.map((s) => s.key),
    ["0", "1", "2"],
    "tool 3 is under the floor",
  );
  assert.deepEqual(
    lattice.levels[2]!.map((s) => [s.key, s.support]),
    [
      ["0,1", 15],
      ["0,2", 10],
      ["1,2", 10],
    ],
  );
  assert.deepEqual(
    lattice.levels[3]!.map((s) => [s.key, s.support]),
    [["0,1,2", 10]],
  );
  assert.equal(lattice.levels.length, 4);
  assert.equal(lattice.count, 4);
  assert.equal(lattice.truncated, false);
});

test("the candidate budget keeps the best supported itemsets of the level it cuts", () => {
  const size = 20;
  const all = Array.from({ length: size }, (_, i) => i);
  const tools = [
    bitsetOf(size, all),
    bitsetOf(size, all),
    bitsetOf(size, all.slice(0, 15)),
    bitsetOf(size, all.slice(0, 12)),
  ];
  const lattice = mineItemsets(tools, { floor: 1, maxSize: 8, maxCandidates: 2 });
  assert.equal(lattice.truncated, true);
  assert.equal(lattice.count, 2);
  assert.deepEqual(
    lattice.levels[2]!.map((s) => s.key),
    ["0,1", "0,2"],
  );
});
