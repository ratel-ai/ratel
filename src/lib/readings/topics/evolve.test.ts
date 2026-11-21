import assert from "node:assert/strict";
import { test } from "node:test";
import {
  candidateGroups,
  type EvolveInput,
  evolveTopics,
  type Namer,
} from "@/lib/readings/topics/evolve";
import type { NamingGroup } from "@/lib/readings/topics/name";
import { ask } from "@/lib/readings/topics/test-fixtures";
import type { StoredTopic } from "@/lib/readings/topics/types";

const NOW = new Date("2026-10-20T12:00:00Z");
const DAY = 86_400_000;

function stored(over: Partial<StoredTopic> & { topicId: string; name: string }): StoredTopic {
  return {
    description: "",
    labelSource: "llm",
    model: "m",
    inputHash: "h",
    retiredAt: null,
    createdAt: new Date(NOW.getTime() - 40 * DAY),
    ...over,
  };
}

const DELIVERY = [
  ask("check delivery status of PO 12", 4),
  ask("check the delivery status of the switchgear", 3),
];
const RENTAL = [ask("rent a scissor lift for monday", 3), ask("rent an excavator for monday", 3)];
const STRAY = [ask("what time is it", 1)];

function input(over: Partial<EvolveInput>): EvolveInput {
  return {
    now: NOW,
    topics: [],
    asks: [...DELIVERY, ...RENTAL, ...STRAY],
    placed: new Map(),
    askedTurns: 14,
    name: null,
    model: null,
    lastNamingHash: null,
    newId: (seed) => `t_${seed.slice(0, 6)}`,
    fullWindow: true,
    ...over,
  };
}

test("the unplaced asks grouped by wording are the candidates, one-off asks last", () => {
  const groups = candidateGroups([...DELIVERY, ...RENTAL, ...STRAY], new Map(), 14);
  assert.deepEqual(
    groups.map((g) => g.turns),
    [7, 6, 1],
    "a one-off ask is shown too: a model may join it to others",
  );
  const placed = new Map(DELIVERY.map((a) => [a.hash, "t_delivery"]));
  assert.deepEqual(
    candidateGroups([...DELIVERY, ...RENTAL], placed, 14).map((g) => g.turns),
    [6],
  );
});

test("a first reading without a model names each big group from its own asks", async () => {
  const result = await evolveTopics(input({}));
  assert.equal(result.naming, "words");
  assert.deepEqual(
    result.created.map((t) => [t.name, t.labelSource, t.description]),
    [
      ["Check delivery status", "words", ""],
      ["Rent an excavator for monday", "words", ""],
    ],
  );
  assert.equal(result.changed, true);
  for (const a of DELIVERY) assert.equal(result.assigned.get(a.hash), result.created[0]!.topicId);
  assert.equal(result.assigned.has(STRAY[0]!.hash), false);
});

test("with a model, one call names the new groups and may join one to an existing topic", async () => {
  const existing = stored({ topicId: "t_delivery", name: "Material delivery" });
  const seen: NamingGroup[][] = [];
  const namer: Namer = async (groups) => {
    seen.push(groups);
    const at = (word: string) =>
      groups.findIndex((g) => g.topicId === null && g.asks.some((a) => a.includes(word)));
    return [
      {
        name: "Material delivery",
        description: "Where a delivery is.",
        groups: [0, at("switchgear")],
      },
      {
        name: "Equipment rental",
        description: "Renting lifts and excavators.",
        groups: [at("excavator")],
      },
    ];
  };
  const placed = new Map<string, string | null>([[DELIVERY[0]!.hash, "t_delivery"]]);
  const asks = [DELIVERY[0]!, ask("delivery status for the switchgear", 5), ...RENTAL];
  const result = await evolveTopics(
    input({ topics: [existing], asks, placed, name: namer, model: "claude-sonnet-5" }),
  );
  assert.equal(seen.length, 1, "one call");
  assert.deepEqual(
    seen[0]!.map((g) => [g.topicId, g.name, g.turns]),
    [
      ["t_delivery", "Material delivery", 4],
      [null, null, 6],
      [null, null, 5],
    ],
    "the existing topic first, then the new groups busiest first",
  );
  assert.equal(result.naming, "model");
  assert.deepEqual(
    result.created.map((t) => [t.name, t.labelSource, t.model]),
    [["Equipment rental", "llm", "claude-sonnet-5"]],
  );
  assert.equal(result.assigned.get(asks[1]!.hash), "t_delivery", "joined to the existing topic");
  assert.equal(result.renamed.length, 0, "a model-named topic keeps its name");
  assert.deepEqual(
    result.active.map((t) => t.topicId),
    ["t_delivery", result.created[0]!.topicId],
    "oldest first",
  );
});

test("a topic named from words gets a model name when one is available; its id stays", async () => {
  const words = stored({ topicId: "t_words", name: "Rent for monday", labelSource: "words" });
  const placed = new Map<string, string | null>(RENTAL.map((a) => [a.hash, "t_words"]));
  const namer: Namer = async () => [
    { name: "Equipment rental", description: "Renting lifts.", groups: [0] },
  ];
  const result = await evolveTopics(
    input({ topics: [words], asks: RENTAL, placed, askedTurns: 6, name: namer, model: "m2" }),
  );
  assert.deepEqual(
    result.renamed.map((t) => [t.topicId, t.name, t.labelSource]),
    [["t_words", "Equipment rental", "llm"]],
  );
  assert.equal(result.changed, true);
});

test("the same naming input is never sent twice", async () => {
  let calls = 0;
  const namer: Namer = async () => {
    calls += 1;
    return [];
  };
  const first = await evolveTopics(input({ name: namer }));
  assert.equal(calls, 1);
  assert.equal(first.created.length, 0, "the model named nothing, so nothing is made up");
  const second = await evolveTopics(input({ name: namer, lastNamingHash: first.namingHash }));
  assert.equal(calls, 1, "skipped");
  assert.equal(second.naming, "none");
});

test("a topic with no asks for a whole window is retired; a young one, or a capped reading, keeps it", async () => {
  const quiet = stored({ topicId: "t_quiet", name: "Quiet" });
  const young = stored({
    topicId: "t_young",
    name: "Young",
    createdAt: new Date(NOW.getTime() - 3 * DAY),
  });
  const busy = stored({ topicId: "t_busy", name: "Busy" });
  const placed = new Map<string, string | null>(
    [...DELIVERY, ...RENTAL].map((a) => [a.hash, "t_busy"]),
  );
  const result = await evolveTopics(input({ topics: [quiet, young, busy], placed }));
  assert.deepEqual(
    result.retired.map((t) => [t.topicId, t.retiredAt?.toISOString()]),
    [["t_quiet", NOW.toISOString()]],
  );
  assert.deepEqual(result.active.map((t) => t.topicId).sort(), ["t_busy", "t_young"]);
  const capped = await evolveTopics(input({ topics: [quiet, busy], placed, fullWindow: false }));
  assert.equal(capped.retired.length, 0);
});

test("no topic is added past the cap", async () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    stored({ topicId: `t_${i}`, name: `Topic ${i}`, createdAt: new Date(NOW.getTime() - DAY) }),
  );
  const result = await evolveTopics(input({ topics: many }));
  assert.equal(result.created.length, 0);
  assert.equal(result.changed, false);
});

test("the model may join small groups into one new topic, which must still hold enough turns", async () => {
  const asks = [
    ask("who is Emeka", 4),
    ask("who is on the team", 3),
    ask("who is Chen", 3),
    ask("read the pricing FAQ", 3),
  ];
  const namer: Namer = async (groups) => {
    const who = groups.flatMap((g, index) =>
      g.asks.some((a) => a.startsWith("who")) ? [index] : [],
    );
    const faq = groups.findIndex((g) => g.asks.some((a) => a.includes("FAQ")));
    return [
      { name: "Team members", description: "Who is on the team.", groups: who },
      { name: "Documents", description: "Reading documents.", groups: [faq] },
    ];
  };
  const result = await evolveTopics(input({ asks, askedTurns: 100, name: namer }));
  assert.deepEqual(
    result.created.map((t) => t.name),
    ["Team members"],
    "three turns of documents are too few for a topic",
  );
  for (const a of asks.slice(0, 3))
    assert.equal(result.assigned.get(a.hash), result.created[0]!.topicId);
  assert.equal(result.assigned.has(asks[3]!.hash), false);
});

test("a few unplaced asks are not many: nothing is looked for", () => {
  assert.deepEqual(
    candidateGroups([ask("who is Emeka", 3)], new Map(), 1_000),
    [],
    "3 turns of 1,000 asks",
  );
});

test("closing thanks never become a topic", () => {
  const thanks = [ask("ok thanks", 9), ask("Perfect, thank you", 8)];
  assert.deepEqual(candidateGroups(thanks, new Map(), 17), []);
});

test("without a model, a group whose name says the same as a topic's joins it instead of becoming another", async () => {
  const existing = stored({
    topicId: "t_create",
    name: "Create task in project",
    labelSource: "words",
    createdAt: new Date(NOW.getTime() - DAY),
  });
  const asks = [ask("Create a task in a project", 6)];
  const result = await evolveTopics(input({ topics: [existing], asks, askedTurns: 6 }));
  assert.equal(result.created.length, 0, "no second topic that says the same");
  assert.equal(result.assigned.get(asks[0]!.hash), "t_create");
});
