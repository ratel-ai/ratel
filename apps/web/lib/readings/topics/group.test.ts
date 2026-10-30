import assert from "node:assert/strict";
import { test } from "node:test";
import { groupByWording, representativeAsk, wordsName } from "@/lib/readings/topics/group";
import { ask } from "@/lib/readings/topics/test-fixtures";

test("asks group by shared words, busiest group first", () => {
  const groups = groupByWording([
    ask("check delivery status of PO-26-1184", 4),
    ask("book a site inspection for friday", 3),
    ask("check the delivery status of the switchgear", 2),
    ask("schedule a site inspection", 2),
    ask("rent a scissor lift", 1),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.turns, group.asks.map((a) => a.key)]),
    [
      [6, ["check delivery status of po-26-1184", "check the delivery status of the switchgear"]],
      [5, ["book a site inspection for friday", "schedule a site inspection"]],
      [1, ["rent a scissor lift"]],
    ],
  );
});

test("the representative ask shares the most words with its group", () => {
  const group = [
    ask("delivery status for rebar", 1),
    ask("check delivery status of PO 7", 1),
    ask("check delivery status", 1),
  ];
  assert.equal(representativeAsk(group).text, "check delivery status");
});

test("a topic named from its own asks keeps the words most of them share, never ids", () => {
  assert.equal(
    wordsName([
      ask("Check delivery status of PO-26-1184", 2),
      ask("check the delivery status of the switchgear", 1),
      ask("check delivery status for rebar", 1),
    ]),
    "Check delivery status",
  );
  assert.equal(
    wordsName([ask("look up task PRJ-123", 1), ask("look up task PRJ-456", 1)]),
    "Look up task",
    "a short word between shared ones stays",
  );
  assert.equal(
    wordsName([ask("tasks about onboarding", 3), ask("open tasks mentioning billing", 1)]),
    "Tasks about onboarding",
    "one shared word: the ask itself",
  );
  assert.equal(
    wordsName([ask("what is the R-value for roof insulation at 4471 Lakeview", 1)]),
    "What is the R-value for roof",
    "digits out, six words at most",
  );
});
