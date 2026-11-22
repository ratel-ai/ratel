import assert from "node:assert/strict";
import { test } from "node:test";
import {
  askSimilarity,
  type Candidate,
  type KnownEval,
  type LowReading,
  pickCandidates,
} from "./candidates";

const QUALITY: LowReading = {
  scorerId: "s-quality",
  scorerName: "Answer quality",
  value: 0.4,
  threshold: 0.7,
};
const SPEED: LowReading = {
  scorerId: "s-speed",
  scorerName: "Fast enough",
  value: 0.1,
  threshold: 0.5,
};

function candidate(turnId: string, over: Partial<Candidate> = {}): Candidate {
  return {
    turnId,
    ask: `Ask number ${turnId} about something unique ${turnId}x`,
    toolPath: ["search"],
    endedAt: new Date("2026-11-01T10:00:00Z"),
    lows: [QUALITY],
    ...over,
  };
}

test("candidates rank by how far under the threshold they are, then by how recent", () => {
  const picks = pickCandidates(
    [
      candidate("a", { lows: [{ ...QUALITY, value: 0.6 }] }),
      candidate("b", { lows: [{ ...QUALITY, value: 0.1 }] }),
      candidate("c", {
        lows: [{ ...QUALITY, value: 0.6 }],
        endedAt: new Date("2026-11-05T10:00:00Z"),
      }),
    ],
    [],
    5,
  );
  assert.deepEqual(
    picks.map((pick) => pick.candidate.turnId),
    ["b", "c", "a"],
  );
});

test("the reason is the reading furthest under its threshold", () => {
  const [pick] = pickCandidates([candidate("a", { lows: [QUALITY, SPEED] })], [], 5);
  assert.deepEqual(pick!.reason, SPEED);
});

test("two runs with the same failing scorers, the same tool path and a near-identical ask give one suggestion", () => {
  const picks = pickCandidates(
    [
      candidate("a", {
        ask: "Refund order 42 for me please",
        toolPath: ["lookup_order", "refund"],
        lows: [{ ...QUALITY, value: 0.5 }],
      }),
      candidate("b", {
        ask: "refund order 43 for me, please",
        toolPath: ["lookup_order", "refund"],
        lows: [{ ...QUALITY, value: 0.2 }],
      }),
    ],
    [],
    5,
  );
  assert.deepEqual(
    picks.map((pick) => pick.candidate.turnId),
    ["b"],
    "The worse run stands for the pair.",
  );
});

test("a near-identical ask is not a duplicate when the tool path or the failing scorers differ", () => {
  const ask = "Refund order 42 for me please";
  const picks = pickCandidates(
    [
      candidate("a", { ask, toolPath: ["lookup_order", "refund"] }),
      candidate("b", { ask, toolPath: ["refund"] }),
      candidate("c", { ask, toolPath: ["lookup_order", "refund"], lows: [QUALITY, SPEED] }),
    ],
    [],
    5,
  );
  assert.equal(picks.length, 3);
});

test("a different ask on the same path and scorers is not a duplicate", () => {
  const picks = pickCandidates(
    [
      candidate("a", { ask: "Refund order 42 for me please" }),
      candidate("b", { ask: "Book a table for two tonight" }),
    ],
    [],
    5,
  );
  assert.equal(picks.length, 2);
});

test("a candidate that is a near-duplicate of an existing eval is not suggested", () => {
  const existing: KnownEval[] = [
    { message: "Refund order 7 for me please", toolPath: ["refund"], scorerIds: null },
    { message: "Book a table for two tonight", toolPath: null, scorerIds: ["s-quality"] },
  ];
  const picks = pickCandidates(
    [
      candidate("a", { ask: "refund order 42 for me please", toolPath: ["refund"] }),
      candidate("b", { ask: "Book a table for two tonight!", toolPath: ["book"] }),
      candidate("c", { ask: "Book a table for two tonight", lows: [SPEED] }),
    ],
    existing,
    5,
  );
  assert.deepEqual(
    picks.map((pick) => pick.candidate.turnId),
    ["c"],
    "Unknown parts of an existing eval match anything; known ones must match.",
  );
});

test("picks stop at the cap, keeping the worst", () => {
  const candidates = Array.from({ length: 8 }, (_, n) =>
    candidate(`r${"abcdefgh"[n]}`, { lows: [{ ...QUALITY, value: n / 20 }] }),
  );
  const picks = pickCandidates(candidates, [], 3);
  assert.deepEqual(
    picks.map((pick) => pick.candidate.turnId),
    ["ra", "rb", "rc"],
  );
  assert.deepEqual(pickCandidates(candidates, [], 0), []);
});

test("a candidate with no low reading is never picked", () => {
  assert.deepEqual(pickCandidates([candidate("a", { lows: [] })], [], 5), []);
});

test("ask similarity ignores case, punctuation and the digits of IDs", () => {
  assert.equal(askSimilarity("Refund order 42!", "refund ORDER 9001"), 1);
  assert.equal(askSimilarity("", ""), 1);
  assert.ok(askSimilarity("Refund order 42", "Book a table") < 0.2);
});
