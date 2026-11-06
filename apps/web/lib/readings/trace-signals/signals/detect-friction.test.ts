import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeTurns } from "@/lib/readings/trace-signals/signals/analyze";
import { round4 } from "@/lib/readings/trace-signals/signals/build";
import {
  call,
  type OtelWorld,
  otelWorld,
  trace,
} from "@/lib/readings/trace-signals/signals/otel-test-fixtures";
import { wilsonLow } from "@/lib/readings/trace-signals/signals/severity";
import { contextFor, times } from "@/lib/readings/trace-signals/signals/test-fixtures";
import type { DetectedSignal } from "@/lib/readings/trace-signals/signals/types";

function analyze(world: OtelWorld) {
  return analyzeTurns(world.turns, contextFor(world.turns, { otel: world.facts }));
}

function only(signals: readonly DetectedSignal[], kind: string): DetectedSignal[] {
  return signals.filter((s) => s.kind === kind);
}

/* - blocked_action ------------------------------------------------------- */

test("blocked_action fires on a tool refused for permission or budget, and names the code", () => {
  const world = otelWorld([
    ...times(3, () =>
      trace([call("ads_set_budget", { error: "result:http_403:tool_not_declared" })]),
    ),
    ...times(1, () => trace([call("ads_set_budget", { error: "result:insufficient_credits" })])),
    ...times(6, () => trace([call("ads_set_budget")])),
  ]);
  const [signal, ...rest] = only(analyze(world).signals, "blocked_action");
  assert.equal(rest.length, 0);
  assert.ok(signal);
  assert.equal(signal.subjectKey, "ads_set_budget");
  assert.equal(signal.metrics.k, 4);
  assert.equal(signal.metrics.n, 10);
  assert.equal(signal.metrics.calls, 4);
  assert.equal(signal.metrics.code, "tool_not_declared");
  assert.equal(signal.severity, round4(wilsonLow(4, 10)));
});

test("blocked_action ignores failures that are not about access, and stays silent below its floors", () => {
  const other = otelWorld(
    times(10, () => trace([call("a", { error: "result:http_500:missing_provenance" })])),
  );
  assert.equal(
    only(analyze(other).signals, "blocked_action").length,
    0,
    "a 500 is a failure, not a refusal",
  );
  const once = otelWorld(times(2, () => trace([call("a", { error: "result:http_403" })])));
  assert.equal(
    only(analyze(once).signals, "blocked_action").length,
    0,
    "two refusals are under three",
  );
});

test("a tool that ran and found nothing is not an unknown tool", () => {
  const world = otelWorld(
    times(8, () => trace([call("ads_read_draft", { error: "result:http_404:draft_not_found" })])),
  );
  assert.equal(only(analyze(world).signals, "unknown_tool").length, 0);
  assert.ok(
    only(analyze(world).signals, "error_loop").length > 0,
    "it is still a failure the error kinds read",
  );
});

/* - identical_retry ------------------------------------------------------ */

test("identical_retry fires when a failed call is sent again with the same arguments", () => {
  const world = otelWorld([
    ...times(4, () =>
      trace([
        call("update_proposal", { error: "result:http_409", args: "h1" }),
        call("update_proposal", { args: "h1" }),
      ]),
    ),
    ...times(6, () =>
      trace([
        call("update_proposal", { error: "result:http_409", args: "h1" }),
        call("update_proposal", { args: "h2" }),
      ]),
    ),
  ]);
  const [signal] = only(analyze(world).signals, "identical_retry");
  assert.ok(signal);
  assert.equal(signal.subjectKey, "update_proposal");
  assert.equal(signal.metrics.k, 4);
  assert.equal(signal.metrics.n, 10, "out of the turns where it failed");
  assert.equal(signal.severity, round4(wilsonLow(4, 10)));
});

test("identical_retry is not measured without captured arguments, and a changed call is no retry", () => {
  const blind = otelWorld(times(10, () => trace([call("a", { error: "boom" }), call("a")])));
  const result = analyze(blind);
  assert.equal(only(result.signals, "identical_retry").length, 0);
  assert.equal(result.measured.has("identical_retry"), false);
  const fixed = otelWorld(
    times(10, () => trace([call("a", { error: "boom", args: "x" }), call("a", { args: "y" })])),
  );
  assert.equal(only(analyze(fixed).signals, "identical_retry").length, 0);
});

/* - wait_heavy ----------------------------------------------------------- */

test("wait_heavy fires on a tool that holds a large share of turn time with long calls", () => {
  const world = otelWorld(
    times(12, () =>
      trace([call("plan"), call("wait_for_run", { tookMs: 90_000 }), call("send_update")], {
        stepMs: 60_000,
      }),
    ),
  );
  const [signal, ...rest] = only(analyze(world).signals, "wait_heavy");
  assert.equal(rest.length, 0, "only the waiting tool");
  assert.ok(signal);
  assert.equal(signal.subjectKey, "wait_for_run");
  assert.equal(signal.metrics.calls, 12);
  assert.equal(signal.metrics.medianMs, 90_000);
  assert.ok(Number(signal.metrics.share) >= 0.15);
});

test("wait_heavy stays silent for short calls, however often", () => {
  const world = otelWorld(
    times(40, () => trace([call("lookup", { tookMs: 800 })], { stepMs: 1_000 })),
  );
  assert.equal(only(analyze(world).signals, "wait_heavy").length, 0);
});

/* - token_heavy ---------------------------------------------------------- */

test("token_heavy fires when a few turns use most of the input tokens", () => {
  const world = otelWorld([
    ...times(57, () => trace([call("a")], { modelCalls: 2, inputTokens: 20_000 })),
    ...times(3, () => trace([call("a")], { modelCalls: 40, inputTokens: 2_000_000 })),
  ]);
  const [signal] = only(analyze(world).signals, "token_heavy");
  assert.ok(signal);
  assert.equal(signal.subjectKind, "project");
  assert.equal(signal.metrics.k, 3);
  assert.equal(signal.metrics.n, 60);
  assert.ok(Number(signal.metrics.tokenShare) > 0.8);
  assert.equal(signal.evidence.totalTurns, 3);
});

test("token_heavy stays silent when tokens are spread evenly", () => {
  const world = otelWorld(
    times(60, () => trace([call("a")], { modelCalls: 3, inputTokens: 50_000 })),
  );
  assert.equal(only(analyze(world).signals, "token_heavy").length, 0);
});

/* - system_turn_failing -------------------------------------------------- */

test("system_turn_failing fires when turns a background task started fail far more than people's", () => {
  const world = otelWorld([
    ...times(6, () =>
      trace([call("publish", { error: "result:http_500" })], {
        modelCalls: 2,
        startedBy: "system",
      }),
    ),
    ...times(18, () => trace([call("publish")], { modelCalls: 2, startedBy: "system" })),
    ...times(2, () =>
      trace([call("publish", { error: "boom" })], { modelCalls: 1, startedBy: "person" }),
    ),
    ...times(198, () => trace([call("publish")], { modelCalls: 1, startedBy: "person" })),
  ]);
  const [signal] = only(analyze(world).signals, "system_turn_failing");
  assert.ok(signal);
  assert.equal(signal.metrics.k, 6);
  assert.equal(signal.metrics.n, 24);
  assert.equal(signal.metrics.personTurns, 200);
  assert.equal(signal.metrics.personShare, 0.01);
  assert.equal(signal.severity, round4(wilsonLow(6, 24)));
});

test("system_turn_failing is silent when background turns fail no more than people's, and unmeasured without prompts", () => {
  const even = otelWorld([
    ...times(5, () =>
      trace([call("a", { error: "boom" })], { modelCalls: 1, startedBy: "system" }),
    ),
    ...times(20, () => trace([call("a")], { modelCalls: 1, startedBy: "system" })),
    ...times(20, () =>
      trace([call("a", { error: "boom" })], { modelCalls: 1, startedBy: "person" }),
    ),
    ...times(80, () => trace([call("a")], { modelCalls: 1, startedBy: "person" })),
  ]);
  assert.equal(only(analyze(even).signals, "system_turn_failing").length, 0, "20% against 20%");
  const blind = otelWorld(
    times(30, () => trace([call("a", { error: "boom" })], { modelCalls: 1 })),
  );
  assert.equal(analyze(blind).measured.has("system_turn_failing"), false);
});

/* - agent_failing -------------------------------------------------------- */

test("agent_failing names the subagent whose calls fail far more than the others', and the tools behind it", () => {
  const world = otelWorld([
    ...times(8, () =>
      trace([
        call("write_file", { error: "boom", agent: "video-editor" }),
        call("glob", { agent: "video-editor" }),
      ]),
    ),
    ...times(4, () =>
      trace([
        call("glob", { error: "boom", agent: "video-editor" }),
        call("read_file", { agent: "video-editor" }),
      ]),
    ),
    ...times(20, () =>
      trace([
        call("read_file", { agent: "video-editor" }),
        call("edit", { agent: "video-editor" }),
      ]),
    ),
    ...times(60, () =>
      trace([call("search", { agent: "growth" }), call("send_update", { agent: "growth" })]),
    ),
    ...times(2, () => trace([call("search", { error: "boom", agent: "growth" })])),
  ]);
  const signals = only(analyze(world).signals, "agent_failing");
  assert.deepEqual(
    signals.map((s) => s.subjectKey),
    ["agent:video-editor"],
  );
  const [signal] = signals;
  assert.equal(signal!.metrics.agent, "video-editor");
  assert.equal(signal!.metrics.k, 12);
  assert.equal(signal!.metrics.n, 64);
  assert.deepEqual(signal!.subjectIds, ["write_file", "glob"]);
});

test("agent_failing needs two named agents", () => {
  const world = otelWorld(
    times(40, () =>
      trace([call("a", { error: "boom", agent: "solo" }), call("b", { agent: "solo" })]),
    ),
  );
  const result = analyze(world);
  assert.equal(only(result.signals, "agent_failing").length, 0);
  assert.equal(result.measured.has("agent_failing"), false);
});
