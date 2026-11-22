import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHAIN_LIMIT,
  CHAIN_MIN_TURNS,
  commonChains,
  PREREQ_LIMIT,
  PREREQ_MIN_TURNS,
  PREREQ_SPARSE_BELOW,
  PREREQ_STRONG_CONFIDENCE,
  PREREQ_USUAL_CONFIDENCE,
  readPrerequisites,
  readStoredPrerequisites,
} from "@/lib/readings/trace-signals/flow-journey-insights";
import type { FlowJourney, FlowJourneyPath } from "@/lib/readings/trace-signals/view";
import { FLOW_JOURNEY_OTHER } from "@/lib/readings/trace-signals/view";

function path(tools: string[], turns: number): FlowJourneyPath {
  return { start: "none", tools, end: "ended", turns };
}

/** A journey of these paths, padded with one-call `filler` turns up to `total` turns. */
function journey(paths: FlowJourneyPath[], total?: number): FlowJourney {
  const counted = paths.reduce((sum, p) => sum + p.turns, 0);
  const all = total && total > counted ? [...paths, path(["filler"], total - counted)] : paths;
  const ids = [...new Set(all.flatMap((p) => p.tools))].sort();
  return {
    steps: 8,
    turns: all.reduce((sum, p) => sum + p.turns, 0),
    paths: all,
    tools: ids.map((id) => ({
      id,
      kind: id === FLOW_JOURNEY_OTHER ? ("other" as const) : ("tool" as const),
      label: id === FLOW_JOURNEY_OTHER ? "Other tools" : `${id} label`,
      tint: "none" as const,
      signalIds: [],
      flags: [],
    })),
    otherTools: [0, 0, 0],
    searchSignalIds: [],
  };
}

const chainKeys = (j: FlowJourney) => commonChains(j).map((c) => [c.tools.join(">"), c.turns]);

test("chains: runs of two or more calls that repeat, weighted by turns, with labels and share", () => {
  const j = journey(
    [path(["find", "assign"], 30), path(["find", "assign"], 10), path(["search", "details"], 8)],
    200,
  );
  const chains = commonChains(j);
  assert.deepEqual(
    chains.map((c) => [c.tools.join(">"), c.turns, c.score]),
    [
      ["find>assign", 40, 40],
      ["search>details", 8, 8],
    ],
  );
  assert.deepEqual(chains[0].labels, ["find label", "assign label"]);
  assert.equal(chains[0].share, 40 / 200);
});

test("chains: one-call turns never make a chain, and an empty journey has none", () => {
  assert.deepEqual(commonChains(journey([path(["a"], 90), path(["b"], 40)])), []);
  assert.deepEqual(commonChains(undefined), []);
  assert.deepEqual(commonChains(journey([])), []);
});

test("chains: support needs 5 turns and 1% of all turns", () => {
  assert.deepEqual(
    chainKeys(journey([path(["a", "b"], CHAIN_MIN_TURNS - 1)], 100)),
    [],
    "4 turns is too few",
  );
  assert.deepEqual(chainKeys(journey([path(["a", "b"], CHAIN_MIN_TURNS)], 100)), [["a>b", 5]]);
  assert.deepEqual(chainKeys(journey([path(["a", "b"], 9)], 1000)), [], "9 of 1,000 is under 1%");
  assert.deepEqual(
    chainKeys(journey([path(["a", "b"], 10)], 1000)),
    [["a>b", 10]],
    "10 of 1,000 is 1%",
  );
});

test("chains: a call repeated back to back breaks the chain, but coming back later does not", () => {
  const j = journey([path(["a", "a", "b"], 20), path(["a", "b", "a"], 20)], 100);
  assert.deepEqual(chainKeys(j), [
    ["a>b>a", 20],
    ["a>b", 40],
  ]);
  assert.ok(
    commonChains(j).every((c) => c.tools.every((id, i) => id !== c.tools[i - 1])),
    "no A then A",
  );
});

test("chains: nothing through a folded tool, which stands for many tools", () => {
  const j = journey(
    [path(["a", FLOW_JOURNEY_OTHER, "b", "c"], 30), path([FLOW_JOURNEY_OTHER, "d"], 30)],
    100,
  );
  assert.deepEqual(chainKeys(j), [["b>c", 30]]);
});

test("chains: counted once per turn, however often the turn runs them", () => {
  const j = journey([path(["a", "b", "a", "b"], 10)], 100);
  const ab = commonChains(j, 20).find((c) => c.tools.join(">") === "a>b");
  assert.equal(
    ab,
    undefined,
    "a>b sits inside a>b>a>b with all of its turns, so only the longest shows",
  );
  assert.deepEqual(chainKeys(j), [["a>b>a>b", 10]]);
});

test("chains: only the longest shape shows when it holds 80% of the shorter one's turns", () => {
  const nested = journey([path(["a", "b", "c"], 40), path(["a", "b"], 10)], 400);
  assert.deepEqual(
    chainKeys(nested),
    [["a>b>c", 40]],
    "40 of a>b's 50 turns is 80%: a>b gives way",
  );
  const split = journey([path(["a", "b", "c"], 39), path(["a", "b"], 11)], 400);
  assert.deepEqual(
    chainKeys(split),
    [
      ["a>b>c", 39],
      ["a>b", 50],
    ],
    "39 of 50 is under 80%: both are habits",
  );
});

test("chains: ranked by turns × (calls − 1), longer first on a tie, at most six", () => {
  const j = journey(
    [
      path(["a", "b", "c"], 20),
      path(["d", "e"], 40),
      path(["f", "g"], 30),
      ...["h", "i", "j", "k", "l"].map((id) => path([id, "z"], 10)),
    ],
    1000,
  );
  const chains = commonChains(j);
  assert.equal(chains.length, CHAIN_LIMIT);
  assert.deepEqual(
    chains.slice(0, 3).map((c) => c.tools.join(">")),
    ["a>b>c", "d>e", "f>g"],
    "a>b>c scores 40 like d>e, and is longer",
  );
});

/** B ran in 100 turns, 80 of them after A; A ran in 90 of 1,000 turns. */
const PAIR = journey([path(["a", "b"], 80), path(["b"], 20), path(["a"], 10)], 1000);

const pairs = (j: FlowJourney) =>
  readPrerequisites(j).relations.map((r) => `${r.first}>${r.tool} ${r.tier}`);

test("needs first: confidence is the share of B's turns where A ran earlier, lift is that over A's share of turns", () => {
  const reading = readPrerequisites(PAIR);
  assert.equal(reading.relations.length, 1);
  const [row] = reading.relations;
  assert.equal(row.tool, "b");
  assert.equal(row.toolLabel, "b label");
  assert.equal(row.first, "a");
  assert.equal(row.firstLabel, "a label");
  assert.equal(row.turns, 100);
  assert.equal(row.together, 80);
  assert.equal(row.confidence, 0.8);
  assert.equal(row.tier, "strong", "80% is almost always");
  assert.ok(Math.abs(row.lift - 0.8 / (90 / 1000)) < 1e-9);
  assert.deepEqual(reading.toolTurns, { a: 90, b: 100 }, "turns of every tool drawn");
});

test("needs first: anywhere earlier in the turn counts, not only the call right before", () => {
  const j = journey([path(["find", "other_step", "update"], 30), path(["update"], 5)], 500);
  const row = readPrerequisites(j).relations.find((r) => r.tool === "update" && r.first === "find");
  assert.equal(row?.together, 30);
});

test("needs first: the tool needs 20 turns and lift 2; 80% is strong, 60% usual", () => {
  assert.deepEqual(
    pairs(journey([path(["a", "b"], PREREQ_MIN_TURNS - 1)], 1000)),
    [],
    "19 turns is too few",
  );
  assert.deepEqual(pairs(journey([path(["a", "b"], PREREQ_MIN_TURNS)], 1000)), ["a>b strong"]);
  assert.deepEqual(
    pairs(journey([path(["a", "b"], 79), path(["b"], 21)], 1000)),
    ["a>b usual"],
    "79% is only usually",
  );
  assert.deepEqual(
    pairs(journey([path(["a", "b"], 59), path(["b"], 41)], 1000)),
    [],
    "59% is not even usually",
  );
  assert.equal(PREREQ_STRONG_CONFIDENCE, 0.8);
  assert.equal(PREREQ_USUAL_CONFIDENCE, 0.6);
  // A runs in nearly every turn, so it running before B says nothing.
  const everywhere = journey([path(["a", "b"], 90), path(["b"], 10), path(["a"], 60)], 200);
  assert.ok(
    readPrerequisites(everywhere).relations.every((r) => r.first !== "a"),
    "lift 0.9 ÷ 0.75 is under 2",
  );
});

test("needs first: the usually tier shows only while strong relations are fewer than two", () => {
  const oneStrong = journey(
    [path(["a", "b"], 90), path(["b"], 10), path(["c", "d"], 70), path(["d"], 30)],
    2000,
  );
  assert.deepEqual(
    pairs(oneStrong),
    ["a>b strong", "c>d usual"],
    "one strong relation: the usual one joins, after it",
  );
  const reading = readPrerequisites(oneStrong);
  assert.equal(reading.strong, 1);
  assert.equal(reading.usual, 1);

  const twoStrong = journey(
    [
      path(["a", "b"], 90),
      path(["b"], 10),
      path(["e", "f"], 50),
      path(["c", "d"], 70),
      path(["d"], 30),
    ],
    2000,
  );
  assert.deepEqual(
    pairs(twoStrong),
    ["a>b strong", "e>f strong"],
    "two strong relations: the usual one stays out",
  );
  assert.equal(readPrerequisites(twoStrong).usual, 1, "still counted");
  assert.equal(PREREQ_SPARSE_BELOW, 2);
});

test("needs first: a tool can need more than one tool first", () => {
  const j = journey(
    [
      path(["find", "members", "assign"], 60),
      path(["members", "find", "assign"], 30),
      path(["assign"], 5),
    ],
    3000,
  );
  assert.deepEqual(
    pairs(j)
      .filter((p) => p.includes(">assign"))
      .sort(),
    ["find>assign strong", "members>assign strong"],
  );
});

test("needs first: B ran before A is not A before B, and folded tools are skipped", () => {
  const j = journey([path(["b", "a"], 80), path([FLOW_JOURNEY_OTHER, "c"], 80)], 1000);
  assert.deepEqual(pairs(j), ["b>a strong"], "the folded tool before c is no one tool");
});

test("needs first: heaviest first, strong before usual, at most the limit", () => {
  const ids = ["c", "d", "e", "f", "g", "h", "i", "j", "k"];
  const j = journey(
    ids.map((id, k) => path([`${id}_first`, id], 30 + k * 10)),
    5000,
  );
  const { relations, strong } = readPrerequisites(j);
  assert.equal(strong, ids.length);
  assert.equal(relations.length, PREREQ_LIMIT);
  assert.deepEqual(
    relations.slice(0, 2).map((r) => r.tool),
    ["k", "j"],
    "110 and 100 turns at 100% lead",
  );
  const weights = relations.map((r) => r.confidence * r.turns);
  assert.deepEqual(
    weights,
    [...weights].sort((p, q) => q - p),
  );
});

test("needs first: when nothing qualifies, the reading says what came closest and how many turns had one call", () => {
  const j = journey([path(["a", "b"], 30), path(["b"], 70), path(["c"], 100)], 400);
  const reading = readPrerequisites(j);
  assert.deepEqual(reading.relations, []);
  assert.equal(reading.closest?.first, "a");
  assert.equal(reading.closest?.tool, "b");
  assert.equal(reading.closest?.confidence, 0.3);
  assert.equal(reading.singleCallShare, (70 + 100 + 200) / 400, "one call or none");
  assert.deepEqual(readPrerequisites(undefined).relations, []);
});

/* - Pairs the run stored, counted across a session ------------------------ */

function withStored(
  pairs: {
    first: string;
    tool: string;
    uses: number;
    window: number;
    turn: number;
    windowLift?: number;
    turnLift?: number;
  }[],
): FlowJourney {
  return {
    ...PAIR,
    prerequisites: {
      windowMs: 10 * 60_000,
      pairs: pairs.map((p) => ({ windowLift: 5, turnLift: 5, ...p })),
    },
  };
}

test("stored pairs: read with the same tiers, as window or turn pairs, and marked when they cross turns", () => {
  const reading = readStoredPrerequisites(
    withStored([
      { first: "create_tag", tool: "add_tag", uses: 42, window: 39, turn: 4 },
      { first: "find", tool: "assign", uses: 98, window: 98, turn: 98 },
      { first: "search", tool: "details", uses: 80, window: 50, turn: 48 },
    ]),
  )!;
  assert.deepEqual(
    reading.relations.map((r) => [
      `${r.first}>${r.tool}`,
      r.tier,
      r.scope,
      r.crossTurn,
      r.turns,
      r.together,
    ]),
    [
      ["find>assign", "strong", "window", false, 98, 98],
      ["create_tag>add_tag", "strong", "window", true, 42, 39],
    ],
    "two strong pairs, so the usual one stays out; create_tag mostly ran a turn earlier",
  );
  assert.equal(reading.relations[1].windowMinutes, 10);
  assert.equal(reading.usual, 1);
});

test("stored pairs: one that only qualifies inside a turn is read as a turn pair; thresholds and lift hold", () => {
  const reading = readStoredPrerequisites(
    withStored([
      { first: "a", tool: "b", uses: 40, window: 36, turn: 36, windowLift: 1.5, turnLift: 4 },
      { first: "c", tool: "d", uses: 19, window: 19, turn: 19 },
      { first: "e", tool: "f", uses: 50, window: 29, turn: 29 },
      { first: "sync", tool: "g", uses: 60, window: 60, turn: 60, windowLift: 1, turnLift: 1 },
    ]),
  )!;
  assert.deepEqual(
    reading.relations.map((r) => [`${r.first}>${r.tool}`, r.scope]),
    [["a>b", "turn"]],
  );
  assert.equal(reading.relations[0].crossTurn, false);
});

test("stored pairs: none stored reads as null, so the card falls back to the paths", () => {
  assert.equal(readStoredPrerequisites(PAIR), null);
  assert.equal(readStoredPrerequisites(undefined), null);
  assert.deepEqual(
    readStoredPrerequisites(withStored([]))?.relations,
    [],
    "stored but empty is an empty reading, not a fallback",
  );
});
