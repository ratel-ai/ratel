import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_URL } from "@/lib/platform/app-config";
import {
  buildBoostWarning,
  buildGraphSteps,
  buildGraphWarnings,
  buildLiveRecall,
  buildProjectSteps,
  connectSnippet,
  type GraphSetupFacts,
  type ProjectSetupFacts,
} from "@/lib/views/adaptive-ranking/setup";

const NOW = new Date("2026-09-30T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

const project = (over: Partial<ProjectSetupFacts> = {}): ProjectSetupFacts => ({
  sources: [],
  graphs: [],
  ...over,
});
const runtimeSource = (
  sourceId: string,
  searches: number,
  invokes: number,
): ProjectSetupFacts["sources"][number] => ({
  sourceId,
  lane: "runtime",
  searches,
  invokes,
  silentCalls: 0,
});
const agentSource = (
  sourceId: string,
  asks: number,
  toolCalls: number,
  silentCalls = 0,
): ProjectSetupFacts["sources"][number] => ({
  sourceId,
  lane: "otlp",
  searches: asks,
  invokes: toolCalls,
  silentCalls,
});
const projectStates = (f: ProjectSetupFacts) =>
  Object.fromEntries(buildProjectSteps(f).steps.map((s) => [s.key, s.state]));

test("a project with nothing yet has both steps pending, with the lines to paste under the first", () => {
  const { steps, allDone } = buildProjectSteps(project());
  assert.equal(allDone, false);
  assert.deepEqual(projectStates(project()), { events: "pending", building: "pending" });
  assert.match(
    steps[0]!.snippet ?? "",
    /attach\(runtime, \{ baseUrl: "[^"]+", apiKey: process\.env\.RATEL_API_KEY, sourceId: "your-runtime" \}\)/,
  );
});

test("the snippet is filled with the runtime's own source and its Ratel graph key, in the order that works", () => {
  const code = connectSnippet("billing-agent");
  assert.match(code, /graphKey: "cloud\/billing-agent"/);
  assert.match(code, /learn: false/);
  assert.match(code, /onReplaced: use/);
  assert.ok(
    code.indexOf("attach(runtime") < code.indexOf("attachIntentGraphSync(runtime"),
    "telemetry is attached before ranking is enabled",
  );
  assert.match(
    connectSnippet("billing-agent", "cloud"),
    /graphKey: "cloud"/,
    "the merged graph under its own key",
  );
});

test("searches without tool calls are a problem the customer can act on; the build waits for its first graph", () => {
  const s = projectStates(project({ sources: [runtimeSource("a", 40, 0)] }));
  assert.equal(s.events, "problem");
  assert.equal(s.building, "pending");
});

test("the project steps are done once events arrive and a graph exists; the rest is each graph's own", () => {
  const f = project({
    sources: [runtimeSource("billing-agent", 300, 280)],
    graphs: [{ graphKey: "cloud", rev: 300, clusterCount: 90 }],
  });
  const { steps, allDone } = buildProjectSteps(f);
  assert.equal(allDone, true);
  assert.deepEqual(
    steps.map((s) => s.key),
    ["events", "building"],
  );
  assert.match(steps[1]!.detail, /300 turns into 90 query groups/);
});

test("an agent without the SDK counts too: its asks over OpenTelemetry, and the content-capture problem when they are missing", () => {
  const detail = (f: ProjectSetupFacts) => buildProjectSteps(f).steps[0]!;

  // Traces alone are enough to be done.
  const traces = project({
    sources: [agentSource("pm-agent", 120, 110)],
    graphs: [{ graphKey: "cloud", rev: 110, clusterCount: 30 }],
  });
  assert.equal(projectStates(traces).events, "done");
  assert.match(
    detail(traces).detail,
    /^1 agent sent 120 asks and 110 tool calls over OpenTelemetry in the last day\.$/,
  );

  // Both lanes, one sentence each.
  const both = project({
    sources: [runtimeSource("worker-a", 300, 280), agentSource("pm-agent", 120, 110)],
  });
  assert.match(
    detail(both).detail,
    /1 runtime sent 300 searches and 280 tool calls; 1 agent sent 120 asks and 110 tool calls over OpenTelemetry/,
  );

  // Model calls that carry no ask: content capture is off, and that is a problem the customer can fix.
  const silent = project({ sources: [agentSource("pm-agent", 0, 40, 40)] });
  assert.equal(projectStates(silent).events, "problem");
  assert.match(detail(silent).detail, /Content capture is off for pm-agent/);
  assert.equal(
    detail(silent).snippet,
    undefined,
    "the fix is in the exporter, not the lines to paste",
  );

  // One agent fine, another silent: done is not claimed while a fix is due.
  const mixed = project({
    sources: [agentSource("pm-agent", 120, 110), agentSource("billing-agent", 0, 9, 9)],
  });
  assert.equal(projectStates(mixed).events, "problem");
  assert.match(
    detail(mixed).detail,
    /1 agent sent 120 asks and 110 tool calls over OpenTelemetry[\s\S]*Content capture is off for billing-agent/,
    "the silent agent's tool calls are not evidence and are not counted",
  );

  // Nothing at all: pending, with the lines to paste and the OpenTelemetry alternative named.
  assert.match(detail(project()).detail, /OpenTelemetry exporter at Ratel with content capture on/);
});

const graphFacts = (over: Partial<GraphSetupFacts> = {}): GraphSetupFacts => ({
  graph: { graphKey: "cloud/billing-agent", rev: 120, updatedAt: ago(1) },
  runtimes: [],
  now: NOW,
  ...over,
});
const runtime = (over: Partial<GraphSetupFacts["runtimes"][number]> = {}) => ({
  sourceId: "billing-agent",
  status: "active",
  graphKey: "cloud/billing-agent",
  learn: false,
  rev: 120,
  observedAt: ago(2),
  ...over,
});
const graphStates = (f: GraphSetupFacts) =>
  Object.fromEntries(buildGraphSteps(f).steps.map((s) => [s.key, s.state]));

test("a graph's steps are done when a runtime ranks from it and follows it; results changing is performance, not setup", () => {
  const f = graphFacts({ runtimes: [runtime()] });
  assert.equal(buildGraphSteps(f).allDone, true);
  assert.deepEqual(
    buildGraphSteps(f).steps.map((s) => s.key),
    ["connected", "following"],
  );
});

test("only runtimes on this graph count, and the snippet names this graph's source", () => {
  // A runtime on another graph does not connect this one.
  const other = graphFacts({
    runtimes: [runtime({ sourceId: "support-agent", graphKey: "cloud/support-agent" })],
  });
  assert.deepEqual(graphStates(other), { connected: "pending", following: "pending" });
  const connect = buildGraphSteps(other).steps[0]!;
  assert.match(connect.detail, /add these lines where billing-agent starts/);
  assert.match(
    connect.snippet ?? "",
    /sourceId: "billing-agent"[\s\S]*graphKey: "cloud\/billing-agent"/,
  );

  // The merged graph names whoever consumes it, under the key "cloud".
  const merged = buildGraphSteps(
    graphFacts({ graph: { graphKey: "cloud", rev: 5, updatedAt: ago(1) } }),
  );
  assert.match(merged.steps[0]!.snippet ?? "", /sourceId: "your-runtime"[\s\S]*graphKey: "cloud"/);
});

test("a runtime learning into its copy of the graph is told to pass learn: false", () => {
  const connected = buildGraphSteps(
    graphFacts({ runtimes: [runtime({ learn: true })] }),
  ).steps.find((s) => s.key === "connected")!;
  assert.equal(connected.state, "problem");
  assert.match(connected.detail, /learn: false/);
});

test("a runtime that stopped adopting newer revisions is flagged, with the onReplaced fix", () => {
  // The graph changed twenty minutes ago and the runtime is still on the old revision.
  const stuck = buildGraphSteps(
    graphFacts({
      graph: { graphKey: "cloud/billing-agent", rev: 180, updatedAt: ago(20) },
      runtimes: [runtime({ rev: 120, observedAt: ago(45) })],
    }),
  ).steps.find((s) => s.key === "following")!;
  assert.equal(stuck.state, "problem");
  assert.match(stuck.detail, /still on revision 120/);
  assert.match(stuck.snippet ?? "", /onReplaced: use/);

  // A runtime one poll behind is not a problem.
  assert.equal(
    graphStates(
      graphFacts({
        graph: { graphKey: "cloud/billing-agent", rev: 121, updatedAt: ago(1) },
        runtimes: [runtime({ rev: 120, observedAt: ago(4) })],
      }),
    ).following,
    "done",
  );
  // Nor is one that last reported hours ago when the graph changed a minute ago: it has had no poll to adopt it.
  assert.equal(
    graphStates(
      graphFacts({
        graph: { graphKey: "cloud/billing-agent", rev: 121, updatedAt: ago(1) },
        runtimes: [runtime({ rev: 120, observedAt: ago(120) })],
      }),
    ).following,
    "done",
  );
  // A runtime that reported after the change, still on the old revision, past the grace, is stuck.
  assert.equal(
    graphStates(
      graphFacts({
        graph: { graphKey: "cloud/billing-agent", rev: 121, updatedAt: ago(20) },
        runtimes: [runtime({ rev: 120, observedAt: ago(2) })],
      }),
    ).following,
    "problem",
  );
});

test("going live is the runtime's doing: the connect step says so and carries the consume snippet", () => {
  const watching = graphFacts();
  assert.equal(graphStates(watching).connected, "pending");
  const connectStep = buildGraphSteps(watching).steps.find((s) => s.key === "connected")!;
  assert.match(connectStep.detail, /starts in your code/);
  assert.match(connectStep.snippet ?? "", /mode: "consume"/);
  assert.equal(graphStates(graphFacts({ runtimes: [runtime()] })).connected, "done");
});

test("warnings are sentences the customer can act on, and nothing when all is well", () => {
  const quiet = buildGraphWarnings({
    lastEventAt: ago(1),
    graphUpdatedAt: ago(2),
    missingTools: new Map(),
  });
  assert.deepEqual(quiet, []);

  const warnings = buildGraphWarnings({
    lastEventAt: ago(1),
    graphUpdatedAt: ago(60),
    missingTools: new Map([
      ["cloud/billing-agent", 3],
      ["cloud", 1],
      ["acme-app", 9], // a runtime's own graph is its owner's concern
    ]),
  });
  assert.equal(warnings.length, 3);
  assert.match(warnings[0]!, /^cloud promotes 1 tool that is no longer in your catalog/);
  assert.match(
    warnings[1]!,
    /^cloud\/billing-agent promotes 3 tools that are no longer in your catalog/,
  );
  assert.match(warnings[2]!, /has not caught up with recent searches/);
});

test("the boost warning fires only on enough searches and a real share of them worse", () => {
  assert.equal(
    buildBoostWarning({ better: 2, worse: 8, same: 0 }),
    null,
    "ten searches prove nothing",
  );
  assert.equal(
    buildBoostWarning({ better: 20, worse: 6, same: 74 }),
    null,
    "6% worse is the ordinary cost",
  );
  assert.match(
    buildBoostWarning({ better: 10, worse: 30, same: 60 }) ?? "",
    /On 30 of 100 compared searches[\s\S]*stop ranking from it in your runtime/,
    "the warning names the one thing the customer can do",
  );
});

test("the live recall waits for enough turns on both sides and says which way it moved", () => {
  const side = (turns: number, recallAt5: number | null) => ({ turns, recallAt5 });
  assert.equal(buildLiveRecall({ before: side(100, 0.7), after: side(5, 1) }), null);
  assert.equal(
    buildLiveRecall({ before: side(100, null), after: side(80, 0.8) }),
    null,
    "a side that cannot be measured",
  );
  assert.deepEqual(buildLiveRecall({ before: side(100, 0.7), after: side(80, 0.8) }), {
    before: 0.7,
    after: 0.8,
    improved: true,
  });
  assert.equal(buildLiveRecall({ before: side(100, 0.7), after: side(80, 0.66) })?.improved, false);
  assert.equal(buildLiveRecall({ before: side(100, 0.7), after: side(80, 0.702) })?.improved, null);
});

test("the snippet points at this deployment, not the hosted default", () => {
  const code = connectSnippet("billing-agent");
  assert.ok(code.includes(`baseUrl: "${BASE_URL}"`));
  assert.ok(code.includes(`endpoint: "${BASE_URL}/intent-graph"`));
  assert.equal(code.includes("cloud.ratel.sh"), false);
});
