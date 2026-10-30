import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseAsks, distinctAsks, isAnswered, retryTurns } from "@/lib/readings/topics/asks";
import { searchStep, T0, turn } from "@/lib/readings/topics/test-fixtures";

const MINUTE = 60_000;

test("a turn is answered when a tool ran and the last call did not fail", () => {
  assert.equal(isAnswered({ calls: [{ tool: "a", outcome: "ok" }] }), true);
  assert.equal(
    isAnswered({
      calls: [
        { tool: "a", outcome: "error" },
        { tool: "b", outcome: "ok" },
      ],
    }),
    true,
    "recovered",
  );
  assert.equal(
    isAnswered({
      calls: [
        { tool: "a", outcome: "ok" },
        { tool: "b", outcome: "error" },
      ],
    }),
    false,
    "gave up",
  );
  assert.equal(isAnswered({ calls: [] }), false, "no tool ran");
  assert.equal(
    isAnswered({ calls: [{ tool: "a", outcome: "unknown" }] }),
    true,
    "an unknown end is not a failure",
  );
  assert.equal(
    isAnswered({ calls: [{ tool: "a", outcome: "ok" }], refused: true }),
    false,
    "the agent said it could not",
  );
});

test("the users' own words win once there are enough of them; searches stand in until then", () => {
  const few = new Map([
    ["t1", { text: "what is the status of PO 12", source: "user_message" as const }],
    ["t2", { text: "purchase order status", source: "search" as const }],
  ]);
  assert.deepEqual(
    [...chooseAsks(few, 2).keys()],
    ["t1", "t2"],
    "one user ask is not enough: the search stays",
  );
  const plenty = new Map<string, { text: string; source: "user_message" | "prompt" | "search" }>([
    ...few,
    ["t3", { text: "is the slab pour on track", source: "prompt" }],
  ]);
  const chosen = chooseAsks(plenty, 2);
  assert.deepEqual([...chosen.keys()].sort(), ["t1", "t3"], "two user asks: the search is dropped");
  assert.equal(chosen.get("t1")?.source, "user");
  assert.equal(chosen.get("t3")?.source, "prompt");
});

test("asks are long prompts clipped and blanks left out", () => {
  const chosen = chooseAsks(
    new Map([
      ["t1", { text: `  ${"word ".repeat(200)}`, source: "prompt" as const }],
      ["t2", { text: "   ", source: "prompt" as const }],
    ]),
    1,
  );
  assert.equal(chosen.get("t1")?.text.length, 500);
  assert.equal(chosen.has("t2"), false);
});

test("distinct asks fold case and spacing, keep the newest wording, and leave retries out", () => {
  const a = turn({ at: T0 });
  const b = turn({ at: T0 + MINUTE });
  const c = turn({ at: T0 + 2 * MINUTE });
  const d = turn({ at: T0 + 3 * MINUTE });
  const asks = new Map([
    [a.id, { text: "Check delivery status", source: "user" as const }],
    [b.id, { text: "check  DELIVERY status", source: "search" as const }],
    [c.id, { text: "book an inspection", source: "user" as const }],
    [d.id, { text: "book an inspection", source: "user" as const }],
  ]);
  const distinct = distinctAsks([a, b, c, d], asks, new Set([d.id]));
  assert.deepEqual(
    distinct.map((x) => [x.key, x.text, x.turnIds.length, x.user]),
    [
      ["check delivery status", "check  DELIVERY status", 2, true],
      ["book an inspection", "book an inspection", 1, true],
    ],
  );
  assert.deepEqual([...distinct[0]!.tokens].sort(), ["check", "delivery", "status"]);
  assert.match(distinct[0]!.hash, /^[0-9a-f]{32}$/);
});

const trusted = { runs: "all" as const, sessions: true };

test("a turn asking the user's previous question again is a retry of it, in their own words", () => {
  const first = turn({ at: T0 });
  const again = turn({ at: T0 + 2 * MINUTE });
  const other = turn({ at: T0 + 4 * MINUTE });
  const asks = new Map([
    [first.id, { text: "Is the L4 deck pour on track?", source: "user" as const }],
    [again.id, { text: "is the L4 deck pour on track", source: "user" as const }],
    [other.id, { text: "who is on site tomorrow", source: "user" as const }],
  ]);
  assert.deepEqual([...retryTurns([first, again, other], asks, trusted)], [[again.id, first.id]]);
});

test("without text the first searches tell a repeated ask; untrusted sessions tell nothing", () => {
  const first = turn({ at: T0, firstSearch: searchStep("q1") });
  const again = turn({ at: T0 + 2 * MINUTE, firstSearch: searchStep("q1") });
  const asks = new Map([
    [first.id, { text: "deck pour status", source: "search" as const }],
    [again.id, { text: "deck pour status", source: "search" as const }],
  ]);
  assert.deepEqual([...retryTurns([first, again], asks, trusted)], [[again.id, first.id]]);
  assert.equal(retryTurns([first, again], asks, { runs: "all", sessions: false }).size, 0);
});

test("another user's turn, or one past the gap, is not a retry", () => {
  const first = turn({ at: T0, endUserKey: "u1" });
  const otherUser = turn({ at: T0 + MINUTE, endUserKey: "u2" });
  const later = turn({ at: T0 + 60 * MINUTE, endUserKey: "u1" });
  const text = { text: "schedule an inspection", source: "user" as const };
  const asks = new Map([
    [first.id, text],
    [otherUser.id, text],
    [later.id, text],
  ]);
  assert.equal(retryTurns([first, otherUser, later], asks, trusted).size, 0);
});

test('a short "try again" right after the user\'s last turn is a retry of it', () => {
  const first = turn({ at: T0, endUserKey: "u1" });
  const again = turn({ at: T0 + 2 * MINUTE, endUserKey: "u1" });
  const asks = new Map([
    [first.id, { text: "Where is the switchgear for Harbor Point?", source: "prompt" as const }],
    [again.id, { text: "Still nothing? Try once more.", source: "prompt" as const }],
  ]);
  assert.deepEqual([...retryTurns([first, again], asks, trusted)], [[again.id, first.id]]);
  const searched = new Map(
    [...asks].map(([id, ask]) => [id, { ...ask, source: "search" as const }]),
  );
  assert.equal(
    retryTurns([first, again], searched, trusted).size,
    0,
    "only in the user's own words",
  );
});
