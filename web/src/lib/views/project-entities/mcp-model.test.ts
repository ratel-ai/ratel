import assert from "node:assert/strict";
import { test } from "node:test";
import {
  failingToolsHint,
  latencyHint,
  mcpStatus,
  onePerServer,
  showSeenFrom,
  sortMcpServers,
} from "./mcp-model";

/** RP-28: the owner's fixed thresholds and the MCP pages' rules (the approved RP-25 design). */

test("status: failing at 50% errors or more, degraded at 5% or more, healthy below", () => {
  assert.equal(mcpStatus(1), "failing");
  assert.equal(mcpStatus(0.5), "failing");
  assert.equal(mcpStatus(0.4999), "degraded");
  assert.equal(mcpStatus(0.05), "degraded");
  assert.equal(mcpStatus(0.0499), "healthy");
  assert.equal(mcpStatus(0), "healthy");
});

test("the default order is status, then calls", () => {
  const row = (key: string, calls: number, errorRate: number) => ({
    key,
    role: "consumed",
    calls,
    errorRate,
  });
  assert.deepEqual(
    sortMcpServers([
      row("context7", 4, 0),
      row("busy", 400, 0),
      row("beluga_board", 27, 3 / 27),
      row("slack", 2, 1),
      row("flaky", 90, 0.2),
    ]).map((each) => each.key),
    ["slack", "flaky", "beluga_board", "busy", "context7"],
  );
});

test("Seen from shows only when the rows' sides differ", () => {
  assert.equal(showSeenFrom([{ role: "consumed" }, { role: "consumed" }]), false);
  assert.equal(showSeenFrom([{ role: "consumed" }, { role: "provided" }]), true);
  assert.equal(showSeenFrom([]), false);
});

test("under 20 calls the latency KPI says the sample size instead of the p50", () => {
  const ms = (value: number) => `${value} ms`;
  assert.equal(latencyHint(19, 48, ms), "n = 19");
  assert.equal(latencyHint(20, 48, ms), "p50 48 ms");
});

test("the error rate KPI names the tool the errors come from", () => {
  assert.equal(failingToolsHint([{ tool: "task_get", errors: 0 }]), null);
  assert.equal(
    failingToolsHint([
      { tool: "task_get", errors: 0 },
      { tool: "task_update", errors: 3 },
    ]),
    "all task_update",
  );
  assert.equal(
    failingToolsHint([
      { tool: "a", errors: 1 },
      { tool: "b", errors: 4 },
    ]),
    "most in b",
  );
  assert.equal(
    failingToolsHint([
      { tool: "a", errors: 2 },
      { tool: "b", errors: 2 },
    ]),
    "2 tools",
  );
});

test("KPIs count a server once: a server seen from both sides keeps its busiest side", () => {
  const rows = [
    { key: "slack", role: "agent", calls: 10, errorRate: 0.1 },
    { key: "slack", role: "server", calls: 12, errorRate: 0.6 },
    { key: "context7", role: "agent", calls: 4, errorRate: 0 },
  ];
  assert.deepEqual(
    onePerServer(rows).map((row) => `${row.key}|${row.role}`),
    ["slack|server", "context7|agent"],
  );
});
