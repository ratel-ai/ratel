import assert from "node:assert/strict";
import { test } from "node:test";
import { agentHealthToolRows } from "./agent-health-bridge";
import type { DecodedSpan } from "./types";

/** AOBS-5: a tool row carries its MCP server. */

const SPAN: DecodedSpan = {
  traceId: "a".repeat(32),
  spanId: "1".repeat(16),
  parentSpanId: null,
  name: "execute_tool mcp__beluga_board__task_update",
  kind: 1,
  startUnixMs: Date.UTC(2026, 10, 17, 12),
  endUnixMs: Date.UTC(2026, 10, 17, 12) + 40,
  attributes: {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "mcp__beluga_board__task_update",
    "mcp.server.name": "beluga_board",
  },
  events: [],
  statusCode: 0,
  resourceAttributes: {},
  scopeName: null,
};

test("the tool row carries its MCP server", async () => {
  const [row] = await agentHealthToolRows([SPAN], "proj-1", {
    traceTurns: {
      enqueueBuild: async () => null,
      scheduleProjectDrain: () => {},
    },
    agentRunsEnabled: async () => false,
    logError: () => {},
  });
  assert.equal(row.server, "beluga_board");
});
