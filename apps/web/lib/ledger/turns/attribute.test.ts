import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureTurns, turn } from "@/lib/ledger/test-support";

test("invocations pair by invocation_id even when ends arrive out of order", () => {
  const concurrent = turn()
    .invoke("fetch", { invocationId: "inv-1", open: true })
    .invoke("fetch", { invocationId: "inv-2", open: true })
    .error("fetch", { invocationId: "inv-2" })
    .end("fetch", { invocationId: "inv-1" });
  const [start1, start2, error2, end1] = concurrent.rows();

  const [built] = buildFixtureTurns([concurrent]);

  assert.deepEqual(
    built.steps.map((s) => [s.traceEventId, s.endTraceEventId, s.outcome]),
    [
      [start1.id, end1.id, "ok"],
      [start2.id, error2.id, "error"],
    ],
  );
  assert.equal(built.errorCount, 1);
});

test("without invocation ids an end pairs with the oldest open start of its tool", () => {
  const plain = turn()
    .invoke("fetch", { open: true })
    .invoke("fetch", { open: true })
    .end("fetch")
    .error("fetch");
  const [start1, start2, end, error] = plain.rows();

  const [built] = buildFixtureTurns([plain]);

  assert.deepEqual(
    built.steps.map((s) => [s.traceEventId, s.endTraceEventId, s.outcome]),
    [
      [start1.id, end.id, "ok"],
      [start2.id, error.id, "error"],
    ],
  );
});

test("a start without an end is unknown and an end past the pairing window stands alone", () => {
  const late = turn({ turnId: "t1" })
    .invoke("slow", { open: true })
    .wait(11 * 60_000)
    .end("slow");

  const [built] = buildFixtureTurns([late]);

  assert.deepEqual(
    built.steps.map((s) => [s.eventType, s.outcome, s.endTraceEventId]),
    [
      ["invoke_start", "unknown", null],
      ["invoke_end", "ok", null],
    ],
  );
  assert.equal(built.invokeCount, 2);
});

test("attribution comes from the latest earlier search listing the tool", () => {
  const detour = turn().search(["a", "b"]).search(["c", "d", "b"]).invoke("b");

  const [built] = buildFixtureTurns([detour]);
  const invoke = built.steps[2];

  assert.equal(invoke.offeredByOrdinal, 2);
  assert.equal(invoke.offeredSearchOrdinal, 2);
  assert.equal(invoke.offeredRank, 3);
  assert.equal(invoke.firstSearchRank, 2, "search #1 listed it at #2");
  assert.equal(built.firstTry, true);
  assert.equal(
    built.detour,
    false,
    "the second search shares one hit of four with the first: a new ask, not a retry",
  );
});

test("a tool reached only by retrying the same ask misses first try", () => {
  const ask = { query: "open the pricing doc" };
  const miss = turn().search(["a"], ask).search(["b"], ask).invoke("b");

  const [built] = buildFixtureTurns([miss]);
  const invoke = built.steps[2];

  assert.equal(invoke.firstSearchRank, null);
  assert.equal(invoke.offeredSearchOrdinal, 2);
  assert.equal(built.firstTry, false);
  assert.equal(built.detour, true);
});

test("a tool listed by a fresh search for a new ask is still first try", () => {
  const [built] = buildFixtureTurns([turn().search(["a"]).invoke("a").search(["b"]).invoke("b")]);
  assert.equal(built.firstTry, true);
  assert.equal(built.detour, false);
});

test("a tool nobody listed has no offering and a blind turn has no first-try verdict", () => {
  const blind = turn().invoke("x");
  const offTarget = turn().search(["a"]).invoke("x");

  const [blindTurn] = buildFixtureTurns([blind]);
  const [offTargetTurn] = buildFixtureTurns([offTarget]);

  assert.equal(blindTurn.steps[0].offeredRank, null);
  assert.equal(blindTurn.firstTry, null);
  assert.equal(offTargetTurn.firstTry, false);
  assert.equal(offTargetTurn.detour, false);
});

test("a skill invocation is attributed from skill searches only", () => {
  const skills = turn().search(["draft"]).skillSearch(["draft", "review"]).skill("draft");

  const [built] = buildFixtureTurns([skills]);
  const invoke = built.steps[2];

  assert.equal(invoke.targetType, "skill");
  assert.equal(invoke.offeredByOrdinal, 2, "the tool search listing the same id is not an offer");
  assert.equal(invoke.offeredRank, 1);
  assert.equal(invoke.firstSearchRank, null, "search #1 searched tools");
});

test("turn facts: counts, distinct tools, abandoned, hits", () => {
  const abandoned = turn().search(["a", "b", "c"]).search(["d"]);
  const busy = turn().search(["a", "b"]).invoke("a").invoke("a").error("a").invoke("b");

  const [abandonedTurn] = buildFixtureTurns([abandoned]);
  const [busyTurn] = buildFixtureTurns([busy]);

  assert.equal(abandonedTurn.abandoned, true);
  assert.equal(abandonedTurn.hitsTotal, 4);
  assert.equal(abandonedTurn.firstTry, null);
  assert.equal(busyTurn.abandoned, false);
  assert.equal(busyTurn.invokeCount, 3);
  assert.equal(busyTurn.distinctTools, 2);
  assert.equal(busyTurn.errorCount, 1);
  assert.equal(busyTurn.reSearchCount, 0);
});

test("steps keep no text: queries are salted hashes and equal asks hash equal", () => {
  const first = turn().search(["a"], { query: "  Assign The Task " });
  const second = turn().search(["a"], { query: "assign the task" });

  const [a] = buildFixtureTurns([first]);
  const [b] = buildFixtureTurns([second]);

  assert.match(a.steps[0].queryHash ?? "", /^[0-9a-f]{32}$/);
  assert.equal(a.steps[0].queryHash, b.steps[0].queryHash);
  assert.ok(!JSON.stringify(a).includes("assign"));
});
