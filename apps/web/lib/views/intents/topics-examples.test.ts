import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ExampleAsk,
  LEAD_CANDIDATES,
  leadTurnIds,
  pickLeads,
} from "@/lib/views/intents/topics-examples";

function example(id: string, text: string): ExampleAsk {
  return { id, text, source: "user", href: `/project/p1/traces?turn=${id}` };
}

test("each intent's lead example comes from its first few example turns, ids only", () => {
  const candidates = leadTurnIds({
    topics: [
      { id: "t_pay", examples: ["turn-1", "turn-2", "turn-3"] },
      { id: "t_rent", examples: [] },
    ] as never,
  });
  assert.equal(LEAD_CANDIDATES, 2);
  assert.deepEqual(
    [...candidates],
    [
      ["t_pay", ["turn-1", "turn-2"]],
      ["t_rent", []],
    ],
  );
});

test("the lead is the first candidate still there; an intent with none read has no lead", () => {
  const candidates = new Map([
    ["t_pay", ["turn-1", "turn-2"]],
    ["t_order", ["turn-3"]],
    ["t_rent", ["turn-4"]],
  ]);
  const read = [
    example("turn-2", "Has pay app 12 been paid?"),
    example("turn-3", "Where is order 1042?"),
  ];
  const leads = pickLeads(candidates, read);
  assert.deepEqual(
    Object.keys(leads),
    ["t_pay", "t_order"],
    "turn-1 was pruned: its next candidate stands in",
  );
  assert.equal(leads.t_pay!.text, "Has pay app 12 been paid?");
  assert.equal(leads.t_rent, undefined);
});
