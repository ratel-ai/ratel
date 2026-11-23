import assert from "node:assert/strict";
import { test } from "node:test";
import { isLoopTool } from "@/lib/mcp/route-handler";
import type { FixEvalRunRow } from "@/lib/views/eval-gate/schema";
import { simulationFinishedFields } from "./service";

/** RC-68: what the improvement loop dashboard and monitors read off the logs. */

const started = new Date("2026-10-31T10:00:00.000Z");

function runRow(over: Partial<FixEvalRunRow> = {}): FixEvalRunRow {
  return {
    id: "run-1",
    setId: "set-1",
    projectId: "project-1",
    trigger: "manual",
    status: "running",
    nCases: 0,
    nSimulated: 0,
    verdict: null,
    methods: null,
    spend: null,
    startedAt: started,
    createdAt: started,
    ...over,
  } as FixEvalRunRow;
}

test("a completed simulation logs its outcome, method counts and spend, never its content", () => {
  const completed = runRow({
    status: "completed",
    nCases: 12,
    nSimulated: 9,
    verdict: "better",
    methods: {
      replay: 7,
      rerank: 2,
      none: 3,
      reasons: [{ note: "SECRET NOTE", runs: 3 }],
      fidelity: null,
    },
    spend: {
      usd: 0.42,
      calls: 30,
      inputTokens: 1,
      outputTokens: 1,
      capUsd: 1.1,
      capped: false,
      models: ["claude-opus-5-5"],
    },
  });
  const fields = simulationFinishedFields(
    runRow(),
    completed,
    "replay",
    "org-1",
    started.getTime() + 65_000,
  );

  assert.deepEqual(fields, {
    run_id: "run-1",
    set_id: "set-1",
    project_id: "project-1",
    organization_id: "org-1",
    trigger: "manual",
    status: "completed",
    verdict: "better",
    method: "replay",
    n_cases: 12,
    n_simulated: 9,
    methods_replay: 7,
    methods_rerank: 2,
    methods_none: 3,
    spend_usd: 0.42,
    spend_calls: 30,
    duration_ms: 65_000,
  });
  assert.ok(!JSON.stringify(fields).includes("SECRET"));
});

test("a failed simulation logs status failed, with what was stored", () => {
  const fields = simulationFinishedFields(
    runRow({ nCases: 4 }),
    runRow({ status: "failed", nCases: 4 }),
    null,
    null,
  );
  assert.equal(fields.status, "failed");
  assert.equal(fields.n_cases, 4);
  assert.equal(fields.methods_replay, 0);
  assert.equal(fields.spend_usd, 0);
  // The row could not be read back: still one failed line.
  assert.equal(simulationFinishedFields(runRow(), null, null, null).status, "failed");
});

test("the MCP logs tell the improvement-loop tools from the rest", () => {
  assert.equal(isLoopTool("run_eval"), true);
  assert.equal(isLoopTool("list_insights"), true);
  assert.equal(isLoopTool("whoami"), false);
  assert.equal(isLoopTool("list_traces"), false);
});
