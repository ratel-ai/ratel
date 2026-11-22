import assert from "node:assert/strict";
import { test } from "node:test";
import type { TurnAskText } from "@/lib/readings/topics/asks";
import { placeTurns } from "@/lib/readings/topics/job";
import { turn } from "@/lib/readings/topics/test-fixtures";
import { hashText, normalizeAsk } from "@/lib/readings/trace-signals/workflows/decide";

test("each turn's sentiment says whether the model read it or the keyword list did; an agent's search is never read", () => {
  const frustrated = turn();
  const pleased = turn();
  const searched = turn();
  const asks = new Map<string, TurnAskText>([
    [frustrated.id, { text: "That's wrong again", source: "user" }],
    [pleased.id, { text: "thanks, perfect", source: "prompt" }],
    [searched.id, { text: "rebar delivery status", source: "search" }],
  ]);
  const byModel = hashText(normalizeAsk("That's wrong again"));
  const placed = placeTurns(
    [frustrated, pleased, searched],
    asks,
    new Map(),
    new Map(),
    new Map([[byModel, "negative"]]),
    new Set([byModel]),
  );
  assert.deepEqual(
    placed.map((row) => [row.sentiment, row.sentimentByModel]),
    [
      ["negative", true],
      ["positive", false],
      [null, false],
    ],
  );
});
