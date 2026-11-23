import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TURN_CONFIG, type TurnConfig } from "@/lib/ledger/constants";
import { buildFixtureTurns, fixtureEvents, turn } from "@/lib/ledger/test-support";
import { dedupeGateway, orderTimeline, segmentEvents } from "@/lib/ledger/turns/segment";

const CONFIG: TurnConfig = {
  ...DEFAULT_TURN_CONFIG,
  gapMs: 90_000,
  stepCap: 40,
  durationCapMs: 15 * 60_000,
  idleCloseMs: 30 * 60_000,
  gatewayDedupeMs: 2_000,
  pairingWindowMs: 10 * 60_000,
};

function keysOf(turns: ReadonlyArray<{ turnKey: string }>): string[] {
  return turns.map((t) => t.turnKey);
}

test("declared turn ids win and the earlier turn closes on the next one", () => {
  const first = turn({ turnId: "t1" }).search(["a", "b"]).invoke("b");
  const second = turn({ after: first, turnId: "t2", gapMs: 5_000 }).search(["c"]).invoke("c");

  const turns = buildFixtureTurns([first, second], {
    config: CONFIG,
    now: new Date(second.lastReceivedMs + 1),
  });

  assert.deepEqual(keysOf(turns), ["declared:t1", "declared:t2"]);
  assert.deepEqual(
    turns.map((t) => t.turnSource),
    ["declared", "declared"],
  );
  assert.deepEqual(
    turns.map((t) => [t.status, t.endedBy]),
    [
      ["closed", "next_turn"],
      ["open", null],
    ],
  );
});

test("a declared turn is not split by a long gap between its own events", () => {
  const long = turn({ turnId: "t1" })
    .search(["a"])
    .wait(10 * 60_000)
    .invoke("a");

  const turns = buildFixtureTurns([long], { config: CONFIG });

  assert.equal(turns.length, 1);
  assert.equal(turns[0].invokeCount, 1);
});

test("inferred turns split on a gap over 90 s and not at or under it", () => {
  const first = turn().search(["a"]).invoke("a");
  const near = turn({ after: first, gapMs: 90_000 }).search(["b"]).invoke("b");
  const far = turn({ after: near, gapMs: 90_001 }).search(["c"]).invoke("c");

  const turns = buildFixtureTurns([first, near, far], { config: CONFIG });

  assert.equal(turns.length, 2);
  assert.equal(turns[0].turnSource, "inferred");
  assert.equal(turns[0].turnKey, `inferred:${first.rows()[0].id}`);
  assert.equal(turns[0].searchCount, 2);
  assert.equal(turns[0].endedBy, "gap");
  assert.equal(turns[1].turnKey, `inferred:${far.rows()[0].id}`);
});

test("an inferred turn is capped at 40 steps", () => {
  const busy = turn();
  for (let i = 0; i < 45; i++) busy.search([`t${i}`]);

  const turns = buildFixtureTurns([busy], { config: CONFIG });

  assert.deepEqual(
    turns.map((t) => t.searchCount),
    [40, 5],
  );
  assert.equal(turns[0].endedBy, "cap");
});

test("an inferred turn is capped at 15 minutes of event time", () => {
  const slow = turn({ stepMs: 60_000 });
  for (let i = 0; i < 20; i++) slow.search([`t${i}`]);

  const turns = buildFixtureTurns([slow], { config: CONFIG });

  assert.deepEqual(
    turns.map((t) => t.searchCount),
    [16, 4],
  );
  assert.equal(turns[0].endedBy, "cap");
});

test("a search after an invocation stays in the turn: that is the re-search pattern", () => {
  const detour = turn().search(["a", "b"]).invoke("a").search(["c"]).invoke("c");

  const turns = buildFixtureTurns([detour], { config: CONFIG });

  assert.equal(turns.length, 1);
  assert.equal(turns[0].reSearchCount, 1);
  assert.equal(turns[0].invokeCount, 2);
});

test("mixed SDKs: undeclared events join the preceding declared turn within the gap, else start an inferred one", () => {
  const declared = turn({ turnId: "t1" }).search(["a"]).invoke("a");
  const trailing = turn({ after: declared, gapMs: 30_000 }).search(["b"]).invoke("b");
  const later = turn({ after: trailing, gapMs: 120_000 }).search(["c"]);

  const turns = buildFixtureTurns([declared, trailing, later], { config: CONFIG });

  assert.deepEqual(keysOf(turns), ["declared:t1", `inferred:${later.rows()[0].id}`]);
  assert.equal(turns[0].searchCount, 2);
  assert.deepEqual(
    turns[0].steps.map((s) => s.declared),
    [true, true, false, false],
  );
  assert.equal(turns[0].endedBy, "gap");
});

test("gateway rows within 2 s of a native twin are dropped, others stand in", () => {
  const both = turn().gatewaySearch(3).search(["a", "b", "c"]).invoke("a").gatewayInvoke("a");
  const alone = turn({ after: both, gapMs: 5 * 60_000 })
    .gatewaySearch(4)
    .gatewayInvoke("x");

  const events = orderTimeline(fixtureEvents([both, alone]));
  const dedupe = dedupeGateway(events, CONFIG.gatewayDedupeMs);

  assert.equal(dedupe.gatewaySearches, 2);
  assert.equal(dedupe.gatewaySearchesDropped, 1);
  assert.equal(dedupe.gatewayInvocations, 2);
  assert.equal(dedupe.gatewayInvocationsDropped, 1);

  const turns = buildFixtureTurns([both, alone], { config: CONFIG });
  assert.deepEqual(
    turns.map((t) => t.steps.map((s) => s.eventType)),
    [
      ["search", "invoke_start"],
      ["gateway_search", "gateway_invoke"],
    ],
  );
  assert.equal(turns[1].hitsTotal, 4, "a standing-in gateway search counts its hits");
});

test("a gateway invocation of a different tool is not a twin", () => {
  const events = orderTimeline(fixtureEvents([turn().invoke("a").gatewayInvoke("b")]));

  assert.equal(dedupeGateway(events, CONFIG.gatewayDedupeMs).gatewayInvocationsDropped, 0);
});

test("a backwards clock marks the turn and never splits it", () => {
  const skewed = turn().search(["a"]).wait(60_000).invoke("a");
  const start = skewed.rows()[0].occurredAt!.getTime();
  skewed.at(start - 10 * 60_000).search(["b"]);

  const turns = buildFixtureTurns([skewed], { config: CONFIG });

  assert.equal(turns.length, 1);
  assert.equal(turns[0].clockSuspect, true);
  assert.equal(turns[0].steps[2].gapMs, 0, "the negative gap clamps to zero");
});

test("a long call's end joins its start's turn even after the gap", () => {
  const long = turn()
    .search(["a"])
    .invoke("a")
    .wait(5 * 60_000)
    .end("a")
    .search(["b"]);

  const turns = buildFixtureTurns([long], { config: CONFIG });

  assert.equal(turns.length, 1);
  assert.equal(turns[0].steps[1].outcome, "ok");
  assert.equal(turns[0].searchCount, 2);
});

test("the latest turn stays open until its session is idle for 30 minutes", () => {
  const recent = turn().search(["a"]).invoke("a");
  recent.rows();
  const received = recent.lastReceivedMs;

  const open = buildFixtureTurns([recent], {
    config: CONFIG,
    now: new Date(received + 29 * 60_000),
  });
  const idle = buildFixtureTurns([recent], {
    config: CONFIG,
    now: new Date(received + 31 * 60_000),
  });

  assert.deepEqual([open[0].status, open[0].endedBy], ["open", null]);
  assert.deepEqual([idle[0].status, idle[0].endedBy], ["closed", "idle"]);
});

test("an imported run closes as soon as it is built; live runs still wait out the idle window", () => {
  const imported = turn({
    lane: "otlp",
    session: "trace-i",
    traceId: "trace-i",
    source: "langfuse-import",
  }).invoke("a");
  const live = turn({
    lane: "otlp",
    session: "trace-l",
    traceId: "trace-l",
    source: "work-assistant",
  }).invoke("a");
  imported.rows();
  live.rows();
  const now = new Date(Math.max(imported.lastReceivedMs, live.lastReceivedMs) + 1);

  const turns = buildFixtureTurns([imported, live], { config: CONFIG, now });

  const status = (key: string) => turns.find((t) => t.turnKey === key);
  assert.deepEqual(
    [status("otlp:trace-i")?.status, status("otlp:trace-i")?.endedBy],
    ["closed", "idle"],
  );
  assert.deepEqual(
    [status("otlp:trace-l")?.status, status("otlp:trace-l")?.endedBy],
    ["open", null],
  );
});

test("a session that mixes imported and live events waits like a live one", () => {
  const first = turn({
    lane: "otlp",
    session: "s-mixed",
    traceId: "s-mixed",
    source: "langfuse-import",
  }).invoke("a");
  const next = turn({ after: first, gapMs: 1_000, source: "work-assistant" }).invoke("b");
  next.rows();

  const turns = buildFixtureTurns([first, next], {
    config: CONFIG,
    now: new Date(next.lastReceivedMs + 1),
  });

  assert.equal(turns.length, 1);
  assert.deepEqual([turns[0].status, turns[0].endedBy], ["open", null]);
});

test("OTLP rows group by trace, one turn each, with no abandoned verdict", () => {
  const a = turn({ lane: "otlp", session: "trace-a", traceId: "trace-a" })
    .gatewaySearch(5)
    .gatewaySearch(5);
  const b = turn({ lane: "otlp", session: "trace-b", traceId: "trace-b" }).gatewaySearch(5);

  const turns = buildFixtureTurns([a, b], { config: CONFIG });

  assert.deepEqual(keysOf(turns), ["otlp:trace-a", "otlp:trace-b"]);
  assert.deepEqual(
    turns.map((t) => t.turnSource),
    ["otlp", "otlp"],
  );
  assert.equal(turns[0].searchCount, 2, "gateway rows are never deduped on the OTLP lane");
  assert.equal(turns[0].abandoned, null);
});

test("segmentation is independent of input order", () => {
  const events = fixtureEvents([
    turn({ turnId: "t1" }).search(["a"]).invoke("a"),
    turn().search(["b"]).invoke("b").search(["c"]),
  ]);
  const now = new Date(Date.parse("2026-09-02T00:00:00Z"));

  const forward = segmentEvents(events, now, CONFIG)
    .map((t) => t.turnKey)
    .sort();
  const reversed = segmentEvents([...events].reverse(), now, CONFIG)
    .map((t) => t.turnKey)
    .sort();

  assert.deepEqual(forward, reversed);
});
