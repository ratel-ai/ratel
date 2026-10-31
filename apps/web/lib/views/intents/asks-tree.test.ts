import assert from "node:assert/strict";
import { test } from "node:test";
import { asksTree } from "@/lib/views/intents/asks-tree";
import type { AskForGroup, IntentBreakdown } from "@/lib/views/intents/breakdown";

const group = (id: string, asks: number, ways: Array<[string, number]>, more = 0): AskForGroup => ({
  id,
  label: `Group ${id}`,
  named: true,
  quoted: false,
  asks,
  share: 0,
  totalAsks: asks,
  alsoIn: [],
  waysOfAsking: {
    skipped: ways.length === 1,
    ways: ways.map(([way, n]) => ({
      id: way,
      label: `ask ${way}`,
      asks: n,
      of: asks,
      samples: ["a sample"],
    })),
    more,
  },
});

const breakdown = (over: Partial<IntentBreakdown> = {}): IntentBreakdown => ({
  topicId: "t",
  asks: 120,
  placed: 110,
  capped: false,
  whatTheyAskFor: {
    skipped: false,
    groups: [
      group(
        "g1",
        60,
        [
          ["c1", 40],
          ["c2", 15],
        ],
        2,
      ),
      group("g2", 30, [["c3", 30]]),
    ],
    more: 3,
  },
  elsewhere: { asks: 10, groups: [] },
  alsoWants: [],
  ...over,
});

test("an intent's tree keeps its things and their ways, without samples, and a rest for what was not listed", () => {
  const tree = asksTree(breakdown());
  assert.equal(tree.asks, 100, "its own asks: placed, less the ones that read like another intent");
  assert.deepEqual([tree.read, tree.capped], [120, false]);
  assert.deepEqual(
    tree.groups.map((g) => [g.id, g.asks, g.ways.map((w) => w.id), g.restAsks, g.restWays]),
    [
      ["g1", 60, ["c1", "c2"], 5, 2],
      ["g2", 30, [], 0, 0],
    ],
    "a thing asked one way holds no ways",
  );
  assert.deepEqual([tree.restAsks, tree.restGroups], [10, 3]);
  assert.ok(!JSON.stringify(tree).includes("a sample"), "no samples");
});

test("with nothing unlisted there is no rest, and the skipping rule carries over", () => {
  const tree = asksTree(
    breakdown({
      whatTheyAskFor: {
        skipped: true,
        groups: [
          group("g1", 100, [
            ["c1", 60],
            ["c2", 40],
          ]),
        ],
        more: 0,
      },
    }),
  );
  assert.deepEqual([tree.skipped, tree.restAsks, tree.restGroups], [true, 0, 0]);
  assert.deepEqual(
    tree.groups[0]!.ways.map((w) => w.id),
    ["c1", "c2"],
  );
});
