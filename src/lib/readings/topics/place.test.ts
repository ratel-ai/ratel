import assert from "node:assert/strict";
import { test } from "node:test";
import {
  askCases,
  chosenOption,
  placeAsks,
  placeByWords,
  topicOptions,
  topicOptionsHash,
  topicWording,
} from "@/lib/readings/topics/place";
import { SENTIMENT_OPTIONS } from "@/lib/readings/topics/sentiment";
import { ask } from "@/lib/readings/topics/test-fixtures";

const TOPICS = [
  {
    topicId: "t_delivery",
    name: "Material delivery",
    description: "Where a delivery is and whether it arrives in time.",
  },
  {
    topicId: "t_inspection",
    name: "Inspection booking",
    description: "Booking a city or third-party inspection.",
  },
];

test("the options are every topic and none of these; the hash is namespaced and follows them", () => {
  const options = topicOptions(TOPICS);
  assert.deepEqual(
    options.map((o) => o.entryId),
    ["t_delivery", "t_inspection", "none"],
  );
  const hash = topicOptionsHash(options);
  assert.match(hash, /^topics:[0-9a-f]{32}$/);
  assert.equal(topicOptionsHash(topicOptions(TOPICS)), hash, "stable for the same topics");
  assert.notEqual(topicOptionsHash(topicOptions([TOPICS[0]!])), hash);
  assert.match(topicOptionsHash(SENTIMENT_OPTIONS, "topic-sentiment:"), /^topic-sentiment:/);
});

test("a case per distinct ask, keyed by its hash", () => {
  const delivery = ask("check delivery status of PO 12");
  assert.deepEqual(askCases([delivery]), [
    { id: delivery.hash, query: delivery.text, shortlist: [], assumed: "", stratum: "control" },
  ]);
});

test("a verdict counts only when it names a known option", () => {
  const known = new Set(["t_delivery", "none"]);
  assert.equal(chosenOption({ entryId: "t_delivery" }, known), "t_delivery");
  assert.equal(chosenOption({ entryId: "" }, known), null, "declined");
  assert.equal(chosenOption({ entryId: "t_gone" }, known), null, "not an option");
  assert.equal(chosenOption(undefined, known), null);
});

test("by wording, an ask goes to the topic whose asks share the most words, above the bar", () => {
  const wording = [
    topicWording(TOPICS[0]!, [ask("check delivery status of the switchgear")]),
    topicWording(TOPICS[1]!, [ask("schedule a site inspection for friday")]),
  ];
  assert.equal(placeByWords(ask("delivery status for rebar"), wording), "t_delivery");
  assert.equal(
    placeByWords(ask("book an inspection"), wording),
    "t_inspection",
    "the topic's own name counts",
  );
  assert.equal(placeByWords(ask("rent a scissor lift"), wording), null);
});

test("known placements come first, then the rest by wording against them", () => {
  const known1 = ask("PO 12 arrival");
  const viaKnown = ask("PO 12 arrival time", 1);
  const nowhere = ask("rent a scissor lift");
  const gone = ask("old question");
  const { placed, byWords } = placeAsks(
    [known1, viaKnown, nowhere, gone],
    TOPICS,
    new Map([
      [known1.hash, "t_delivery"],
      [gone.hash, "t_retired"],
    ]),
  );
  assert.equal(placed.get(known1.hash), "t_delivery");
  assert.equal(
    placed.get(viaKnown.hash),
    "t_delivery",
    "shares words with an ask known to be in it",
  );
  assert.equal(placed.get(nowhere.hash), null);
  assert.equal(placed.get(gone.hash), null, "a retired topic is not a place");
  assert.deepEqual([...byWords].sort(), [viaKnown.hash, nowhere.hash, gone.hash].sort());
});
