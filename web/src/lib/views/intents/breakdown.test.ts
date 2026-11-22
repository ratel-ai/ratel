import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BreakdownInput,
  buildBreakdowns,
  type PlacedAsk,
  samplesOf,
  summarizeBreakdown,
  WAYS_SHOWN,
} from "@/lib/views/intents/breakdown";

/** Level-0 clusters `c<group><n>` under level-1 groups `G<group>`. */
function input(asks: PlacedAsk[], extra: Partial<BreakdownInput> = {}): BreakdownInput {
  const clusters = new Map<string, { parentId: string | null; label: string }>();
  const groups = new Map<string, { label: string; named: boolean }>();
  for (const ask of asks) {
    for (const c of ask.clusters) {
      const group = c.startsWith("orphan") ? null : `G${c.slice(1, 2)}`;
      clusters.set(c, { parentId: group, label: `ask like ${c}` });
      if (group) groups.set(group, { label: `Group ${group}`, named: group === "Ga" });
    }
  }
  const asksByTopic = new Map<string, number>();
  for (const ask of asks) asksByTopic.set(ask.topicId, (asksByTopic.get(ask.topicId) ?? 0) + 1);
  return { asksByTopic, asks, clusters, groups, capped: new Set<string>(), ...extra };
}

const ask = (topicId: string, ...clusters: string[]): PlacedAsk => ({ topicId, clusters });
const times = (n: number, a: PlacedAsk) => Array.from({ length: n }, () => a);

test("a group belongs to the Intent most of its asks' turns are in, and keeps its split counts", () => {
  const out = buildBreakdowns(
    input([
      ...times(3, ask("delivery", "ca1")),
      ask("schedule", "ca2"),
      ...times(2, ask("schedule", "cb1")),
    ]),
  );
  const delivery = out.get("delivery")!;
  assert.equal(delivery.whatTheyAskFor.groups.length, 1);
  const [a] = delivery.whatTheyAskFor.groups;
  assert.deepEqual([a!.id, a!.asks, a!.totalAsks, a!.share], ["Ga", 3, 4, 1]);
  assert.deepEqual(a!.alsoIn, [{ topicId: "schedule", asks: 1 }]);
  const schedule = out.get("schedule")!;
  assert.deepEqual(
    schedule.whatTheyAskFor.groups.map((g) => [g.id, g.asks]),
    [["Gb", 2]],
  );
  assert.deepEqual(schedule.elsewhere, {
    asks: 1,
    groups: [{ id: "Ga", label: "Group Ga", topicId: "delivery", asks: 1 }],
  });
  assert.equal(schedule.placed, 3);
});

test("an ask that wants two things counts once, in its Intent, and the other Intent is Also wants", () => {
  const asks = [
    ...times(4, ask("delivery", "ca1")),
    ...times(4, ask("schedule", "cb1")),
    // "When does the drywall arrive, and will it push the pour?" in a Delivery turn.
    ask("delivery", "cb2", "ca1"),
    ask("delivery", "ca1", "cb1", "cb2"),
  ];
  const out = buildBreakdowns(input(asks));
  const delivery = out.get("delivery")!;
  assert.equal(delivery.placed, 6, "each ask once");
  assert.deepEqual(
    delivery.whatTheyAskFor.groups.map((g) => [g.id, g.asks]),
    [["Ga", 6]],
    "under the frame that belongs here, even when it is not the first",
  );
  assert.deepEqual(
    delivery.alsoWants,
    [{ topicId: "schedule", asks: 2, share: 2 / 6 }],
    "once per ask, however many frames",
  );
  assert.deepEqual(out.get("schedule")!.alsoWants, []);
});

test("a level with one child is skipped and says so; the child stays for the reader", () => {
  const one = buildBreakdowns(
    input([...times(5, ask("rfi", "cr1")), ...times(2, ask("rfi", "cr2")), ask("pay", "cp1")]),
  );
  const rfi = one.get("rfi")!;
  assert.equal(rfi.whatTheyAskFor.skipped, true);
  assert.equal(rfi.whatTheyAskFor.groups.length, 1);
  assert.equal(rfi.whatTheyAskFor.groups[0]!.waysOfAsking.skipped, false);
  assert.deepEqual(
    rfi.whatTheyAskFor.groups[0]!.waysOfAsking.ways.map((w) => [w.id, w.asks, w.of]),
    [
      ["cr1", 5, 7],
      ["cr2", 2, 7],
    ],
    "true counts: 5 of 7",
  );
  assert.equal(one.get("pay")!.whatTheyAskFor.groups[0]!.waysOfAsking.skipped, true);
  assert.deepEqual(
    summarizeBreakdown(rfi),
    {
      topicId: "rfi",
      asks: 8 - 1,
      placed: 7,
      groups: 1,
      children: 2,
      skipped: true,
      rows: [
        { id: "cr1", kind: "way", label: "ask like cr1", quoted: true, asks: 5, share: 5 / 7 },
        { id: "cr2", kind: "way", label: "ask like cr2", quoted: true, asks: 2, share: 2 / 7 },
      ],
    },
    "with the level skipped, the chevron opens straight onto its ways",
  );

  const two = buildBreakdowns(
    input([...times(3, ask("rfi", "cr1")), ...times(2, ask("rfi", "cs1"))]),
  ).get("rfi")!;
  assert.equal(two.whatTheyAskFor.skipped, false);
  assert.deepEqual(summarizeBreakdown(two).children, 2);
  assert.deepEqual(
    summarizeBreakdown(two).rows.map((r) => [r.kind, r.id, r.label, r.quoted, r.asks, r.share]),
    [
      ["group", "Gr", "ask like cr1", true, 3, 3 / 5],
      ["group", "Gs", "ask like cs1", true, 2, 2 / 5],
    ],
    "otherwise onto its groups",
  );
});

test("ways are listed busiest first up to the cap, the rest counted", () => {
  const asks = Array.from({ length: WAYS_SHOWN + 3 }, (_, i) =>
    times(i + 1, ask("big", `cz${i}`)),
  ).flat();
  const group = buildBreakdowns(input(asks)).get("big")!.whatTheyAskFor.groups[0]!;
  assert.equal(group.waysOfAsking.ways.length, WAYS_SHOWN);
  assert.equal(group.waysOfAsking.more, 3);
  assert.equal(group.waysOfAsking.ways[0]!.id, `cz${WAYS_SHOWN + 2}`);
});

test("an ask the engine has not placed counts in the Intent's asks, never in a group", () => {
  const base = input([...times(2, ask("pay", "cp1")), ask("pay", "orphan1")]);
  const out = buildBreakdowns({ ...base, asksByTopic: new Map([["pay", 10]]) }).get("pay")!;
  assert.equal(out.asks, 10);
  assert.equal(out.placed, 2, "a cluster with no group places nothing");
  assert.equal(out.whatTheyAskFor.groups[0]!.share, 1);
});

test("names say whether a model wrote them", () => {
  const out = buildBreakdowns(input([ask("x", "ca1"), ask("x", "cb1")])).get("x")!;
  assert.deepEqual(out.whatTheyAskFor.groups.map((g) => [g.id, g.named]).sort(), [
    ["Ga", true],
    ["Gb", false],
  ]);
});

test("samples are a cluster's most typical members, its own label and repeats left out", () => {
  const members = [
    "is the slab pour at northgate behind schedule",
    "is the slab pour at harbor point behind schedule",
    "Is the slab pour at Riverside behind schedule?",
    "book the footing inspection at harbor point for the 28th",
    "is the slab pour at northgate behind schedule",
  ];
  const samples = samplesOf(members, "Is the slab pour at Riverside behind schedule?", 2);
  assert.deepEqual(
    [...samples].sort(),
    [
      "is the slab pour at harbor point behind schedule",
      "is the slab pour at northgate behind schedule",
    ],
    "the stray booking is not shown",
  );
  assert.deepEqual(samplesOf([], "x", 3), []);
});

test("a group reads as a model's name, else as its busiest way of asking, quoted; a rule-made name stays the engine's", () => {
  const base = input([
    ...times(3, ask("s", "cq1")),
    ask("s", "cq2"),
    ...times(2, ask("t", "ca1")),
    ...times(2, ask("u", "ce1")),
  ]);
  const groups = new Map(base.groups);
  groups.set("Gq", {
    label: "Is the drywall hang on level {id} at Northgate behind schedule?",
    named: false,
  });
  groups.set("Ge", { label: "Install Eastside", named: false });
  groups.set("Ga", { label: "Check {id}", named: true });
  const out = buildBreakdowns({ ...base, groups });
  const first = (topicId: string) => out.get(topicId)!.whatTheyAskFor.groups[0]!;
  assert.deepEqual([first("s").label, first("s").quoted], ["ask like cq1", true]);
  assert.deepEqual(
    [first("u").label, first("u").quoted],
    ["ask like ce1", true],
    "however a rule-made name reads",
  );
  assert.deepEqual(
    [first("t").label, first("t").quoted],
    ["Check {id}", false],
    "a model's name stands as written",
  );
});

test("only an Intent whose own window held more turns than were read says so", () => {
  const out = buildBreakdowns(
    input([...times(3, ask("busy", "ca1")), ask("quiet", "cb1")], { capped: new Set(["busy"]) }),
  );
  assert.equal(out.get("busy")!.capped, true);
  assert.equal(out.get("quiet")!.capped, false);
});
