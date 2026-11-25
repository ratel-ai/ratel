import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hallucinationsHref,
  parseHallucinationsQuery,
  parseHallucinationsWindow,
} from "@/lib/views/health/hallucinations/paths";

test("a turn opened beside the list is in the address, with the call it is about", () => {
  assert.equal(
    hallucinationsHref("p1", { open: "unknown_reference", turn: "t-1", call: "c-1" }),
    "/project/p1/health/hallucinations?open=unknown_reference&turn=t-1&call=c-1",
  );
});

test("the address's group and kind: a kind names its group, and anything unknown reads as not asked", () => {
  const cases: Array<[Record<string, string | string[] | undefined>, unknown]> = [
    [{}, { group: null, kind: null }],
    [{ group: "input" }, { group: "input", kind: null }],
    // A kind wins over a group that does not hold it, and brings its own.
    [
      { kind: "unknown_tool", group: "completion" },
      { group: "tool", kind: "unknown_tool" },
    ],
    [
      { kind: "made_up", group: "tool" },
      { group: "tool", kind: null },
    ],
    [{ group: "everything" }, { group: null, kind: null }],
    // A repeated parameter reads its first value.
    [
      { kind: ["value_not_allowed", "unknown_tool"] },
      { group: "input", kind: "value_not_allowed" },
    ],
    [{ group: [] }, { group: null, kind: null }],
  ];
  for (const [search, expected] of cases)
    assert.deepEqual(parseHallucinationsQuery(search), expected, JSON.stringify(search));
});

test("the address's window: one of Agent health's, a month by default, never past the plan's", () => {
  assert.equal(parseHallucinationsWindow(undefined, 90), 30);
  assert.equal(parseHallucinationsWindow("7", 90), 7);
  assert.equal(parseHallucinationsWindow("90", 30), 30);
  assert.equal(parseHallucinationsWindow("13", 90), 30);
  assert.equal(parseHallucinationsWindow("lots", 90), 30);
});

test("the address carries a kind or its group, and leaves the default window out", () => {
  assert.equal(hallucinationsHref("p1"), "/project/p1/health/hallucinations");
  assert.equal(hallucinationsHref("p1", { days: 30 }), "/project/p1/health/hallucinations");
  assert.equal(
    hallucinationsHref("p1", { days: 7, group: "tool", kind: "unknown_tool" }),
    "/project/p1/health/hallucinations?days=7&kind=unknown_tool",
  );
  // A turn's call goes only with its turn.
  assert.equal(hallucinationsHref("p1", { call: "c-1" }), "/project/p1/health/hallucinations");
});
