import assert from "node:assert/strict";
import { test } from "node:test";
import { detectRetrieval } from "@/lib/readings/trace-signals/signals/detect-retrieval";
import { buildFlow, FLOW_TOOL_NODES } from "@/lib/readings/trace-signals/signals/flow-model";
import {
  fresh,
  pairsOf,
  signalTurns,
  statsOf,
  times,
} from "@/lib/readings/trace-signals/signals/test-fixtures";

/**
 * `FLOW_TOOL_NODES + 5` busy tools, each run 3 times, and a magnet listed in
 * every search and never run: by invocations it is the least busy tool of all.
 */
function magnetTurns() {
  const busy = times(FLOW_TOOL_NODES + 5, (i) => `busy_${String(i).padStart(2, "0")}`);
  return signalTurns(
    busy.flatMap((tool) => times(3, () => fresh().search([tool, "magnet"]).invoke(tool))),
  );
}

test("a tool with an open signal gets a node even when it is too quiet to earn one", () => {
  const turns = magnetTurns();
  const stats = statsOf(turns);
  const signals = detectRetrieval(stats).signals;
  assert.ok(
    signals.some((s) => s.kind === "magnet" && s.subjectKey === "magnet"),
    "fixture plants a magnet",
  );

  const flow = buildFlow(stats, pairsOf(stats, turns), signals, FLOW_TOOL_NODES + 6);
  const magnet = flow.nodes.find((n) => n.id === "magnet");
  assert.ok(magnet, "the magnet is drawn rather than folded into the quiet plate");
  assert.deepEqual(magnet.signalKeys, ["magnet:magnet"]);
  assert.equal(flow.nodes.filter((n) => n.kind === "tool").length, FLOW_TOOL_NODES);
  assert.equal(flow.nodes.find((n) => n.kind === "quiet")?.quietCount, 6);
});

test("the busiest tools still fill the map in busyness order", () => {
  const turns = magnetTurns();
  const stats = statsOf(turns);
  const flow = buildFlow(
    stats,
    pairsOf(stats, turns),
    detectRetrieval(stats).signals,
    FLOW_TOOL_NODES + 6,
  );
  const tools = flow.nodes.filter((n) => n.kind === "tool").map((n) => n.id);
  assert.deepEqual(tools.slice(0, 3), ["busy_00", "busy_01", "busy_02"]);
  assert.equal(tools.at(-1), "magnet");
});
