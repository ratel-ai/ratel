import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { typedStepFixtures } from "@/lib/ingest/otlp/__fixtures__/typed-steps";
import { deriveModelCalls } from "@/lib/ingest/otlp/derive-model-calls";
import { deriveSteps } from "@/lib/ingest/otlp/derive-steps";
import { buildTurns } from "@/lib/ledger/turns/build-turn";
import { normalizeEvents } from "@/lib/ledger/turns/normalize";
import type { TurnEventRow } from "@/lib/ledger/types";
import { createAnalysis } from "@/lib/readings/trace-signals/signals/analyze";
import { detectRetrieval } from "@/lib/readings/trace-signals/signals/detect-retrieval";
import {
  buildFlow,
  FLOW_TOOL_NODES,
  flowForSteps,
  flowView,
} from "@/lib/readings/trace-signals/signals/flow-model";
import {
  contextFor,
  fresh,
  pairsOf,
  signalTurns,
  statsOf,
  times,
} from "@/lib/readings/trace-signals/signals/test-fixtures";
import { signalKey } from "@/lib/readings/trace-signals/signals/types";
import { layoutJourney } from "@/lib/views/health/flow-journey-layout";

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

test("typed model-only turns store model, code and handoff nodes in call order", () => {
  const turns = signalTurns([fresh().invoke("placeholder")]);
  const turn = turns[0];
  const template = turn.steps.find((step) => step.kind === "invoke")!;
  turn.steps = [
    { ...template, ordinal: 0, kind: "model_call", targetType: null, targetId: "chat" },
    { ...template, ordinal: 1, kind: "code", targetType: null, targetId: "parse" },
    { ...template, ordinal: 2, kind: "handoff", targetType: null, targetId: "writer" },
  ];
  const analysis = createAnalysis(contextFor(turns), { workflowMining: { typedSteps: true } });
  for (const item of turns) analysis.feed(item);
  assert.equal(analysis.secondPass(), true);
  for (const item of turns) analysis.feedPairs(item);
  const flow = analysis.finish().summary.flow;
  assert.deepEqual(flow.stepJourney?.paths[0].t, ["model:chat", "code:parse", "handoff:writer"]);
  assert.equal(flow.journey, undefined);
  const view = flowForSteps(flowView(flow, [], new Map()), "flow");
  const layout = layoutJourney(view.journey, { showAll: true })!;
  const calls = layout.nodes.filter(
    (node) => node.kind === "model_call" || node.kind === "code" || node.kind === "handoff",
  );
  assert.deepEqual(
    calls.map((node) => node.kind),
    ["model_call", "code", "handoff"],
  );
  assert.ok(layout.ribbons.some((edge) => edge.from === calls[0].key && edge.to === calls[1].key));
  assert.ok(layout.ribbons.some((edge) => edge.from === calls[1].key && edge.to === calls[2].key));
});

test("mixed typed paths keep tool signals on tools and obey step presets", () => {
  const turns = signalTurns([fresh().search(["execute_tool"]).invoke("execute_tool")]);
  const turn = turns[0];
  const call = turn.steps.find((step) => step.kind === "invoke")!;
  turn.steps = [
    { ...call, ordinal: 0, kind: "model_call", targetType: null, targetId: "chat" },
    ...turn.steps.map((step, index) => ({ ...step, ordinal: index + 1 })),
  ];
  const run = (typedSteps: boolean) => {
    const analysis = createAnalysis(contextFor(turns), { workflowMining: { typedSteps } });
    for (const item of turns) analysis.feed(item);
    for (const item of turns) analysis.feedPairs(item);
    return analysis.finish().summary.flow;
  };
  const off = run(false);
  const on = run(true);
  assert.deepEqual(on.journey, off.journey);
  const model = flowView(on, [], new Map([["execute_tool", "Execute tool"]]));
  const all = flowForSteps(model, "all");
  assert.deepEqual(all.journey?.paths[0].tools, ["model:chat", "execute_tool"]);
  assert.deepEqual(
    all.journey?.tools.map((node) => [node.id, node.kind, node.label]),
    [
      ["execute_tool", "tool", "Execute tool"],
      ["model:chat", "model_call", "Model call"],
    ],
  );
  assert.deepEqual(
    flowForSteps(model, "tools").journey,
    flowView(off, [], new Map([["execute_tool", "Execute tool"]])).journey,
  );
  assert.deepEqual(flowForSteps(model, "models").journey?.paths[0].tools, ["model:chat"]);
  assert.equal(flowForSteps(model, "intents").journey, undefined);
});

test("tool-only stored flow is identical with typed steps on and off", () => {
  const turns = signalTurns([fresh().search(["a", "b"]).invoke("a").invoke("b")]);
  const run = (typedSteps: boolean) => {
    const analysis = createAnalysis(contextFor(turns), { workflowMining: { typedSteps } });
    for (const turn of turns) analysis.feed(turn);
    for (const turn of turns) analysis.feedPairs(turn);
    return analysis.finish().summary.flow;
  };
  assert.deepEqual(run(true), run(false));
});

test("dead, buried and switched tool signals do not mark model or code steps", () => {
  const turns = signalTurns([fresh().search(["execute_tool"]).invoke("execute_tool")]);
  const template = turns[0].steps.find((step) => step.kind === "invoke")!;
  turns[0].steps = [
    { ...template, kind: "model_call", targetType: null, targetId: "execute_tool", ordinal: 0 },
    { ...template, kind: "code", targetType: null, targetId: "unused", ordinal: 1 },
    { ...template, ordinal: 2 },
    { ...template, targetType: "skill", ordinal: 3 },
  ];
  const base = detectRetrieval(statsOf(magnetTurns())).signals.find(
    (signal) => signal.kind === "magnet",
  )!;
  const signals = (["dead_tool", "buried_tool", "tool_switch"] as const).map((kind) => ({
    ...base,
    kind,
    subjectKey: kind,
    subjectIds: [kind === "dead_tool" ? "unused" : "execute_tool"],
  }));
  const analysis = createAnalysis(contextFor(turns), { workflowMining: { typedSteps: true } });
  for (const turn of turns) analysis.feed(turn);
  for (const turn of turns) analysis.feedPairs(turn);
  const stats = statsOf(turns);
  const stored = {
    ...analysis.finish().summary.flow,
    ...buildFlow(stats, pairsOf(stats, turns), signals, 2),
  };
  const view = flowForSteps(
    flowView(
      stored,
      signals.map((signal) => ({
        key: signalKey(signal),
        id: signal.kind,
        kind: signal.kind,
      })),
      new Map(),
    ),
    "all",
  );
  assert.deepEqual(view.nodes.find((node) => node.id === "unused")?.signalIds, ["dead_tool"]);
  assert.deepEqual(view.journey?.tools.find((node) => node.id === "execute_tool")?.signalIds, [
    "buried_tool",
    "tool_switch",
  ]);
  for (const node of view.journey?.tools.filter((node) => node.kind !== "tool") ?? []) {
    assert.deepEqual(node.signalIds, []);
    assert.equal(node.tint, "none");
  }
});

test("the Stema span fixture stores its code-to-model flow without tool calls", () => {
  const now = new Date();
  const spans = typedStepFixtures(now.getTime() - 3_600_000).stema;
  const rows = [...deriveSteps(spans), ...deriveModelCalls(spans, { typedSteps: true })].map(
    (row) => ({
      ...row,
      id: randomUUID(),
      receivedAt: row.occurredAt ?? now,
      failed: row.errorMessage !== null,
    }),
  );
  const events = normalizeEvents(rows as unknown as TurnEventRow[], new Map(), {
    salt: "fixture",
    typedSteps: true,
  });
  const turns = buildTurns({ stored: [], events, now }).turns.map((turn) => ({
    ...turn,
    id: randomUUID(),
  }));
  const analysis = createAnalysis(contextFor(turns), { workflowMining: { typedSteps: true } });
  for (const turn of turns) analysis.feed(turn);
  assert.equal(analysis.secondPass(), true);
  for (const turn of turns) analysis.feedPairs(turn);
  const stored = analysis.finish().summary.flow;
  assert.equal(stored.journey, undefined);
  assert.equal(stored.stepJourney?.paths[0].t[0], "code:prepare_response");
  assert.match(stored.stepJourney!.paths[0].t[1], /^model:/);
  const layout = layoutJourney(flowForSteps(flowView(stored, [], new Map()), "all").journey, {
    showAll: true,
  })!;
  const code = layout.nodes.find((node) => node.kind === "code")!;
  const model = layout.nodes.find((node) => node.kind === "model_call")!;
  assert.equal(code.label, "Prepare response");
  assert.equal(model.label, "Model call");
  assert.ok(layout.ribbons.some((edge) => edge.from === code.key && edge.to === model.key));
});
