import assert from "node:assert/strict";
import { test } from "node:test";
import type { ManifestTool } from "../../tools-state";
import {
  armDivergence,
  armPath,
  type ReplayArmTurn,
  replayToolModes,
  replayTotals,
  replyDiff,
  toolCallDiff,
} from "../turn-compare";

/** The rules of a chat replay's two-arm compare: tool modes, per-turn diffs, the recorded path and the totals. */

const tool = (name: string, hint: ManifestTool["hint"]): ManifestTool => ({
  name,
  description: "",
  hint,
  param: "tools",
});

function arm(overrides: Partial<ReplayArmTurn>): ReplayArmTurn {
  return {
    status: "ok",
    reply: "",
    calls: [],
    metrics: null,
    runId: null,
    traceId: null,
    error: null,
    ...overrides,
  };
}

test("replayToolModes fakes every tool, unless the reviewer set a mode", () => {
  const tools = [
    tool("searchDocs", "readOnly"),
    tool("createTicket", "sideEffect"),
    tool("ask", "none"),
  ];
  assert.deepEqual(replayToolModes(tools, {}), {
    searchDocs: "fake",
    createTicket: "fake",
    ask: "fake",
  });
  assert.deepEqual(replayToolModes(tools, { ask: { mode: "confirm" } }), {
    searchDocs: "fake",
    createTicket: "fake",
    ask: "confirm",
  });
});

test("toolCallDiff marks same, changed arguments, and calls only one arm made", () => {
  const search = (query: string) => ({ tool: "searchDocs", args: { query }, mode: "fake" });
  const read = { tool: "readDoc", args: { slug: "a" }, mode: "fake" };
  assert.deepEqual(
    toolCallDiff([search("keys"), read], [search("keys"), read]).map((c) => c.kind),
    ["same", "same"],
  );
  assert.deepEqual(toolCallDiff([search("keys")], [search("rotate")]), [
    {
      kind: "changed",
      tool: "searchDocs",
      baseline: { query: "keys" },
      candidate: { query: "rotate" },
    },
  ]);
  assert.deepEqual(
    toolCallDiff([search("keys"), read], [search("keys")]).map((c) => [c.kind, c.tool]),
    [
      ["same", "searchDocs"],
      ["removed", "readDoc"],
    ],
  );
  assert.deepEqual(
    toolCallDiff([read], [search("keys")]).map((c) => [c.kind, c.tool]),
    [
      ["removed", "readDoc"],
      ["added", "searchDocs"],
    ],
  );
  assert.equal(
    toolCallDiff(
      [{ tool: "t", args: { a: 1, b: 2 }, mode: null }],
      [{ tool: "t", args: { b: 2, a: 1 }, mode: null }],
    )[0]!.kind,
    "same",
  );
});

test("replyDiff gives word parts that rebuild both replies", () => {
  assert.deepEqual(replyDiff("same text", "same text"), {
    same: true,
    parts: [{ kind: "same", text: "same text" }],
  });
  const diff = replyDiff("Open Settings, then API keys.", "Open Settings, then Keys and rotate.");
  assert.equal(diff.same, false);
  const baseline = diff.parts
    .filter((p) => p.kind !== "added")
    .map((p) => p.text)
    .join("");
  const candidate = diff.parts
    .filter((p) => p.kind !== "removed")
    .map((p) => p.text)
    .join("");
  assert.equal(baseline, "Open Settings, then API keys.");
  assert.equal(candidate, "Open Settings, then Keys and rotate.");
  assert.deepEqual(diff.parts[0], { kind: "same", text: "Open Settings, then " });
  assert.deepEqual(replyDiff(null, "hi"), { same: false, parts: [{ kind: "added", text: "hi" }] });
});

test("armPath and replayTotals count turns off the recorded path, and sum the finished turns", () => {
  const recorded = [
    [{ tool: "searchDocs", args: { query: "keys" }, result: null, isError: false }],
    [],
  ];
  const onPath = arm({
    calls: [{ tool: "searchDocs", args: { query: "keys" }, mode: "fake", fakeSource: "recorded" }],
    metrics: { inputTokens: 10, outputTokens: 5, costUsd: 0.001, latencyMs: 900 },
  });
  const offPath = arm({
    calls: [{ tool: "createTicket", args: { title: "x" }, mode: "fake" }],
    metrics: { inputTokens: 20, outputTokens: 5, costUsd: 0.002, latencyMs: 1_100 },
  });
  assert.equal(armPath(recorded[0]!, onPath).diverged, false);
  assert.deepEqual(armPath(recorded[1]!, offPath), { diverged: true, firstOffPath: 0 });
  assert.deepEqual(replayTotals([onPath, offPath], recorded), {
    turns: 2,
    failed: 0,
    diverged: 1,
    inputTokens: 30,
    outputTokens: 10,
    costUsd: 0.003,
    latencyMs: 2_000,
  });
  assert.deepEqual(
    replayTotals([arm({ status: "error" }), arm({ status: "running" })], recorded).failed,
    1,
  );
});

test("armDivergence: an off-path call followed by a run error is diverged, and the error status is kept", () => {
  const recorded = [{ tool: "searchDocs", args: { query: "keys" }, result: null, isError: false }];
  const failed = arm({
    status: "error",
    error: "boom",
    calls: [{ tool: "createTicket", args: { title: "x" }, mode: "fake" }],
  });
  assert.deepEqual(armDivergence(recorded, failed), { diverged: true, firstOffPath: 0 });
  assert.equal(failed.status, "error");
  const totals = replayTotals([failed], [recorded]);
  assert.equal(totals.diverged, 1);
  assert.equal(totals.failed, 1);
  assert.equal(totals.turns, 0);
});

test("armDivergence: a failed turn on the recorded path, or with no captured calls, is not diverged", () => {
  const recorded = [{ tool: "searchDocs", args: { query: "keys" }, result: null, isError: false }];
  const onPath = arm({
    status: "error",
    calls: [{ tool: "searchDocs", args: { query: "keys" }, mode: "fake" }],
  });
  assert.deepEqual(armDivergence(recorded, onPath), { diverged: false, firstOffPath: null });
  assert.equal(armDivergence(recorded, arm({ status: "canceled", calls: [] })), null);
  assert.equal(
    armDivergence(
      recorded,
      arm({ status: "running", calls: [{ tool: "createTicket", args: {}, mode: "fake" }] }),
    ),
    null,
  );
  assert.equal(replayTotals([onPath, arm({ status: "error" })], [recorded, recorded]).diverged, 0);
});

test("armDivergence: a canceled turn with an off-path call is diverged", () => {
  const canceled = arm({
    status: "canceled",
    calls: [{ tool: "createTicket", args: {}, mode: "fake" }],
  });
  assert.equal(armDivergence([], canceled)?.diverged, true);
});
