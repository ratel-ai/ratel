import assert from "node:assert/strict";
import { test } from "node:test";
import type { Organization } from "@/lib/platform/organizations";
import { type PersistSpansDeps, persistDecodedSpans } from "./ingest-spans";
import type { OtelSpanRow } from "./span-rows";
import type { DecodedSpan } from "./types";

/**
 * RC-725: an `execute_tool` span keeps its MCP session id and its tool
 * arguments and result in `otel_spans`, for every organization, like the
 * RC-740 agent ask. Other spans stay content-free.
 */

const ARGS = JSON.stringify({ projectId: "p-1", limit: 5 });
const RESULT = JSON.stringify({ ok: true, traces: [] });
const ORG = { id: "org-a", slug: "org-a" } as Organization;

function toolSpan(
  overrides: Partial<DecodedSpan> = {},
  attributes: Record<string, unknown> = {},
): DecodedSpan {
  return {
    traceId: "b".repeat(32),
    spanId: "3".repeat(16),
    parentSpanId: null,
    name: "execute_tool list_traces",
    kind: 1,
    startUnixMs: 1_700_000_000_000,
    endUnixMs: 1_700_000_000_200,
    attributes: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "list_traces",
      "gen_ai.agent.name": "claude-code",
      "mcp.session.id": "derived-1353",
      "gen_ai.tool.call.arguments": ARGS,
      "gen_ai.tool.call.result": RESULT,
      ...attributes,
    },
    events: [],
    statusCode: 0,
    resourceAttributes: { "service.name": "ratel-cloud-mcp" },
    scopeName: "ratel-cloud/mcp",
    ...overrides,
  };
}

function harness() {
  const h = { spanRows: [] as OtelSpanRow[] };
  const deps = {
    insertEventsWithMetrics: async (_projectId: string, rows: unknown[]) => rows.length,
    insertTraceEvents: async (_projectId: string, rows: unknown[]) => ({ accepted: rows.length }),
    insertOtelSpans: async (_projectId: string, rows: OtelSpanRow[]) => {
      h.spanRows.push(...rows);
      return { accepted: rows.length };
    },
    agentSpanDedupe: null,
    logError: () => {},
    captureFailure: () => {},
  } as unknown as PersistSpansDeps;
  return { h, deps };
}

async function persist(
  deps: PersistSpansDeps,
  spans: DecodedSpan[] = [toolSpan()],
  organization: Organization | null = ORG,
) {
  const result = await persistDecodedSpans(
    spans,
    { projectId: "project-1", organization, endpoint: "/v1/traces" },
    deps,
  );
  assert.ok(result.ok);
}

const tool = (h: { spanRows: OtelSpanRow[] }) =>
  h.spanRows.find((row) => row.name.startsWith("execute_tool"))!;

test("the tool span keeps mcp.session.id, its arguments and its result", async () => {
  const { h, deps } = harness();
  await persist(deps);
  const attrs = tool(h).attributes;
  assert.equal(attrs["mcp.session.id"], "derived-1353");
  assert.equal(attrs["gen_ai.tool.call.arguments"], ARGS);
  assert.equal(attrs["gen_ai.tool.call.result"], RESULT);
  assert.equal(attrs["gen_ai.tool.name"], "list_traces");
});

test("a model-call span keeps no tool content", async () => {
  const { h, deps } = harness();
  const chat = toolSpan(
    { spanId: "4".repeat(16), name: "chat claude", kind: 3 },
    { "gen_ai.operation.name": "chat", "gen_ai.input.messages": "[]" },
  );
  await persist(deps, [toolSpan(), chat]);
  const chatRow = h.spanRows.find((row) => row.name.startsWith("chat"))!;
  assert.equal(chatRow.attributes["gen_ai.tool.call.arguments"], undefined);
  assert.equal(chatRow.attributes["gen_ai.input.messages"], undefined);
});

test("a result over the size bound is dropped before the arguments and the content-free keys", async () => {
  const { h, deps } = harness();
  const huge = JSON.stringify({ blob: "x".repeat(20_000) });
  await persist(deps, [toolSpan({}, { "gen_ai.tool.call.result": huge })]);
  const row = tool(h);
  assert.equal(row.attributes["gen_ai.tool.call.result"], undefined);
  assert.equal(row.attributes["gen_ai.tool.call.arguments"], ARGS);
  assert.equal(row.attributes["gen_ai.tool.name"], "list_traces");
  assert.equal(row.attrsTruncated, true);
});

test("a batch with no organization still keeps the tool content", async () => {
  const { h, deps } = harness();
  await persist(deps, [toolSpan()], null);
  assert.equal(tool(h).attributes["gen_ai.tool.call.arguments"], ARGS);
  assert.equal(h.spanRows.length, 1);
});
