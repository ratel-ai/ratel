import assert from "node:assert/strict";
import { test } from "node:test";
import { type ObservabilityOperationDeps, observabilityOperations } from "./observability";

/**
 * Five tools in this file report token and cost totals, computed from two
 * different pipelines. Nothing stops an agent asking one of them "what did this
 * week cost" and quoting a number the customer's own dashboard disagrees with,
 * so these tests pin the two things that make the choice legible: the result
 * says which pipeline produced it, and the description says which questions
 * belong to it.
 *
 * The descriptions carry weight here that they would not on a smaller surface.
 * There is no `search_operations` step in front of these tools, so the name and
 * the description are the entire discovery surface.
 */
/** Enough of each query to run the serializer; the numbers are never asserted. */
const stubDeps = {
  getTraceKpis: async () => ({
    traces: 0,
    errorRate: 0,
    averageLatencyMs: 0,
    p50LatencyMs: 0,
    p95LatencyMs: 0,
  }),
  getTraceDailyAggregates: async () => [],
  listTraces: async () => ({ rows: [], nextCursor: null }),
  getTraceFacets: async () => ({}),
  getSpanAggregates: async () => ({ spans: 0, errors: 0 }),
  getTraceSpansWithTruncation: async () => ({ spans: [], truncated: false }),
  listTraceOperations: async () => [],
  getTracesIngestDiagnostics: async () => ({}),
  getDailyAggregates: async () => [],
  getToolMetrics: async () => ({}),
} as unknown as ObservabilityOperationDeps;

const operations = new Map(observabilityOperations(stubDeps).map((o) => [o.id, o]));

const SPAN_BACKED = ["get_trace_health", "list_span_groups", "get_span_totals"];
const METRICS_BACKED = ["get_cost_by_day", "get_cost_by_tool"];

test("every tool that reports tokens or cost names its own source", async () => {
  for (const id of [...SPAN_BACKED, ...METRICS_BACKED]) {
    const operation = operations.get(id);
    assert.ok(operation, `${id} should exist`);

    const result = await operation.execute(
      {
        auth: { kind: "api-key", projectId: "p", apiKeyId: "k", organization: null },
        projectId: "p",
        organizationId: "o",
        logger: { info() {}, warn() {}, error() {} } as never,
      },
      operation.params.parse({}) as never,
    );

    const source = (result.data as { source?: string }).source;
    assert.equal(
      source,
      SPAN_BACKED.includes(id) ? "spans" : "event_metrics",
      `${id} must label which pipeline its numbers came from`,
    );
  }
});

test("each overlapping tool points at the one to use instead", () => {
  // Without this an agent picks between five similar names by guesswork, and
  // two of the five answer the same question from a different pipeline.
  const crossReferences: Record<string, RegExp> = {
    get_trace_health: /get_cost_by_day/,
    list_span_groups: /get_cost_by_tool/,
    get_span_totals: /get_trace_health|get_cost_by_day/,
    get_cost_by_day: /span/i,
    get_cost_by_tool: /list_span_groups/,
  };

  for (const [id, expected] of Object.entries(crossReferences)) {
    const description = operations.get(id)?.description ?? "";
    assert.match(description, expected, `${id} should say what to use instead`);
  }
});
