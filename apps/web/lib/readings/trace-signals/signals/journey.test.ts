import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeTurns } from "@/lib/readings/trace-signals/signals/analyze";
import { flowView } from "@/lib/readings/trace-signals/signals/flow-model";
import {
  countJourneyPath,
  countJourneyPositions,
  createJourneyStats,
  finishJourney,
  JOURNEY_MAX_PATHS,
  JOURNEY_OTHER_ID,
  JOURNEY_STEPS,
  JOURNEY_TOOLS_PER_STEP,
  type StoredJourney,
  turnJourney,
} from "@/lib/readings/trace-signals/signals/journey";
import {
  contextFor,
  fresh,
  signalTurns,
  times,
} from "@/lib/readings/trace-signals/signals/test-fixtures";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";

function journeyOf(turns: readonly SignalTurn[]): StoredJourney | undefined {
  const stats = createJourneyStats();
  for (const t of turns) countJourneyPositions(stats, t);
  for (const t of turns) countJourneyPath(stats, t);
  return finishJourney(stats);
}

function pathTurns(journey: StoredJourney, s: string, t: readonly string[], e = "end"): number {
  return journey.paths.find((p) => p.s === s && p.e === e && p.t.join(">") === t.join(">"))?.n ?? 0;
}

test("a turn's journey: whether it searched before its first call, and its calls in order", () => {
  const [searched, blind, late, deadEnd, skill] = signalTurns([
    fresh().search(["a"]).invoke("a").invoke("b"),
    fresh().invoke("a").invoke("a"),
    fresh().invoke("a").search(["b"]).invoke("b"),
    fresh().search(["a"]),
    fresh().skill("writer").invoke("a"),
  ]);
  assert.deepEqual(turnJourney(searched), { start: "search", ids: ["a", "b"], more: false });
  assert.deepEqual(
    turnJourney(blind),
    { start: "none", ids: ["a", "a"], more: false },
    "a repeat stays a repeat",
  );
  assert.deepEqual(
    turnJourney(late),
    { start: "none", ids: ["a", "b"], more: false },
    "a search after the first call does not count as the start",
  );
  assert.deepEqual(
    turnJourney(deadEnd),
    { start: "search", ids: [], more: false },
    "searched and ran nothing",
  );
  assert.equal(
    turnJourney({ steps: [] }),
    null,
    "a turn that neither searched nor called has none",
  );
  assert.deepEqual(turnJourney(skill)?.ids, ["skill:writer", "a"]);
});

test("calls past the last step mark the path as going on", () => {
  const [long] = signalTurns([
    times(JOURNEY_STEPS + 2, (i) => `t${i}`).reduce((t, id) => t.invoke(id), fresh()),
  ]);
  const journey = turnJourney(long)!;
  assert.equal(journey.ids.length, JOURNEY_STEPS);
  assert.equal(journey.more, true);
});

test("paths are counted exactly, most turns first", () => {
  const turns = signalTurns([
    ...times(5, () => fresh().search(["a"]).invoke("a").invoke("b")),
    ...times(3, () => fresh().invoke("a")),
    ...times(2, () => fresh().search(["x"])),
    times(JOURNEY_STEPS + 1, () => "c").reduce((t, id) => t.invoke(id), fresh()),
  ]);
  const journey = journeyOf(turns)!;
  assert.equal(journey.turns, 11);
  assert.equal(journey.steps, JOURNEY_STEPS);
  assert.deepEqual(journey.paths[0], { s: "search", t: ["a", "b"], e: "end", n: 5 });
  assert.equal(pathTurns(journey, "none", ["a"]), 3);
  assert.equal(pathTurns(journey, "search", []), 2);
  assert.equal(
    pathTurns(
      journey,
      "none",
      times(JOURNEY_STEPS, () => "c"),
      "more",
    ),
    1,
    "positions up to the cap, then on",
  );
  assert.deepEqual(
    journey.other,
    times(JOURNEY_STEPS, () => 0),
  );
});

test("each position keeps its busiest tools by name and folds the rest into other", () => {
  const tools = times(JOURNEY_TOOLS_PER_STEP + 4, (i) => `tool_${String(i).padStart(2, "0")}`);
  // tool_00 is the busiest first call, tool_12 the quietest.
  const turns = signalTurns(
    tools.flatMap((tool, i) => times(tools.length - i, () => fresh().invoke(tool).invoke("next"))),
  );
  const journey = journeyOf(turns)!;
  const firsts = new Set(journey.paths.map((p) => p.t[0]));
  assert.equal(firsts.size, JOURNEY_TOOLS_PER_STEP + 1, "the busiest by name, and one other");
  assert.ok(firsts.has("tool_00") && firsts.has(JOURNEY_OTHER_ID) && !firsts.has(tools.at(-1)!));
  assert.deepEqual(journey.other, [4, ...times(JOURNEY_STEPS - 1, () => 0)]);
  const other = journey.paths
    .filter((p) => p.t[0] === JOURNEY_OTHER_ID)
    .reduce((sum, p) => sum + p.n, 0);
  assert.equal(other, 4 + 3 + 2 + 1, "the folded tools' turns are all still there");
  assert.equal(journey.turns, turns.length);
});

test("one tool over the limit is kept rather than folded alone", () => {
  const tools = times(JOURNEY_TOOLS_PER_STEP + 1, (i) => `t${i}`);
  const journey = journeyOf(signalTurns(tools.map((tool) => fresh().invoke(tool))))!;
  assert.ok(!journey.paths.some((p) => p.t.includes(JOURNEY_OTHER_ID)));
});

test("past the path cap the rarest paths fold, and every turn is still counted", () => {
  // Ten first tools times ten second tools times ten third: 1,000 distinct paths, over the cap.
  const ids = times(10, (i) => `t${i}`);
  const fixtures = ids.flatMap((a, i) =>
    ids.flatMap((b, j) => ids.map((c, k) => ({ a, b, c, n: 1 + ((i + j + k) % 3) }))),
  );
  const turns = signalTurns(
    fixtures.flatMap(({ a, b, c, n }) => times(n, () => fresh().invoke(a).invoke(b).invoke(c))),
  );
  const journey = journeyOf(turns)!;
  // The rarest keep only their shape: start x end x length, a handful at most.
  assert.ok(
    journey.paths.length <= JOURNEY_MAX_PATHS + 4 * (JOURNEY_STEPS + 1),
    `${journey.paths.length} paths`,
  );
  assert.equal(journey.turns, turns.length);
  assert.equal(
    journey.paths.reduce((sum, p) => sum + p.n, 0),
    turns.length,
  );
  assert.ok(
    journey.other[2] >= journey.other[0] && journey.other[2] > 0,
    `the deepest recorded position folds first: ${journey.other}`,
  );
});

test("no journey without a turn that searched or called", () => {
  assert.equal(journeyOf(signalTurns([fresh(), fresh()])), undefined);
});

test("the run stores the journey beside the flow, even with too few busy tools for pairs", () => {
  const turns = signalTurns(times(4, () => fresh().search(["a"]).invoke("a")));
  const result = analyzeTurns(turns, contextFor(turns));
  assert.equal(result.pairTools, 0, "no pairs to count");
  assert.deepEqual(result.summary.flow.journey?.paths, [{ s: "search", t: ["a"], e: "end", n: 4 }]);
});

test("the view names journey tools, tints them like the map, and leaves old summaries alone", () => {
  const turns = signalTurns([
    ...times(6, () => fresh().search(["a"]).invoke("a").invoke("b")),
    ...times(2, () => fresh().invoke("b")),
  ]);
  const stored = analyzeTurns(turns, contextFor(turns)).summary.flow;
  const view = flowView(stored, [], new Map([["a", "Alpha"]]));
  assert.equal(view.journey?.turns, 8);
  assert.deepEqual(
    view.journey?.tools.map((t) => [t.id, t.label, t.kind]),
    [
      ["a", "Alpha", "tool"],
      ["b", "b", "tool"],
    ],
    "a drawn tool takes the map node's catalog name",
  );
  assert.deepEqual(view.journey?.paths[0], {
    start: "search",
    tools: ["a", "b"],
    end: "ended",
    turns: 6,
  });

  const { journey: _dropped, ...old } = stored;
  assert.equal(
    flowView(old, [], new Map()).journey,
    undefined,
    "a summary from before journeys has none",
  );
});
