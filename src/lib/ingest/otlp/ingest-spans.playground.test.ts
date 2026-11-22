import assert from "node:assert/strict";
import { test } from "node:test";
import type { ParsedTraceEvent } from "@/lib/ingest/trace-events/parse";
import type { Organization } from "@/lib/platform/organizations";
import { type PersistSpansDeps, persistDecodedSpans } from "./ingest-spans";
import type { OtelSpanRow } from "./span-rows";
import type { DecodedSpan } from "./types";

/**
 * RC-1101: a playground run (resource `deployment.environment.name =
 * playground`) is stored in `otel_spans` for Traces. With `cloud-sandboxes` on it
 * adds no cost row and no Agent health row. Off, ingest is unchanged.
 */

const ORG = { id: "org-a", slug: "org-a" } as Organization;
const INPUT = JSON.stringify({ workflowId: "wf-1", typicalOrder: ["search", "read"] });

type Harness = {
  spanRows: OtelSpanRow[];
  costRows: unknown[];
  traceEvents: ParsedTraceEvent[];
  flagReads: number;
};

test("flag on: a playground run is stored for Traces, with no cost row and no Agent health row", async () => {
  const { h, deps } = harness(true);

  const result = await persistDecodedSpans(run(PLAYGROUND), context(), deps);

  assert.equal(result.ok, true);
  assert.equal(h.spanRows.length, 3, "every span is stored in otel_spans");
  const root = h.spanRows.find((row) => row.name === "invoke_agent workflow-label");
  assert.equal(root?.attributes["deployment.environment.name"], "playground");
  assert.equal(root?.attributes["ratel.sandbox.input"], INPUT);
  assert.equal(root?.attributes["ratel.replay.arm"], "candidate");
  assert.deepEqual(h.costRows, [], "no events / event_metrics row");
  assert.deepEqual(h.traceEvents, [], "no Agent health ledger row");
  assert.equal(h.flagReads, 1);
});

test("flag off: a playground run is ingested as on main", async () => {
  const { h, deps } = harness(false);

  await persistDecodedSpans(run(PLAYGROUND), context(), deps);

  assert.equal(h.spanRows.length, 3);
  assert.equal(h.costRows.length, 1, "the model call is a cost row");
  assert.ok(h.traceEvents.length > 0, "the run makes Agent health rows");
});

test("flag on: a production run keeps its cost and Agent health rows, and the flag is not read", async () => {
  const { h, deps } = harness(true);

  await persistDecodedSpans(run(PRODUCTION), context(), deps);

  assert.equal(h.costRows.length, 1);
  assert.ok(h.traceEvents.length > 0);
  assert.equal(h.flagReads, 0);
});

test("a span attribute environment wins over the resource's", async () => {
  const { h, deps } = harness(true);
  const spans = run(PRODUCTION).map((span) => ({
    ...span,
    attributes: { ...span.attributes, "deployment.environment.name": "playground" },
  }));

  await persistDecodedSpans(spans, context(), deps);

  assert.deepEqual(h.costRows, []);
  assert.deepEqual(h.traceEvents, []);
});

test("sandbox and replay keys survive the attribute size bound", async () => {
  const { h, deps } = harness(false);
  const filler = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [
      `ratel.filler.${String(i).padStart(2, "0")}`,
      "x".repeat(500),
    ]),
  );
  const spans = run(PLAYGROUND).map((span, i) =>
    i === 0 ? { ...span, attributes: { ...filler, ...span.attributes } } : span,
  );

  await persistDecodedSpans(spans, context(), deps);

  const root = h.spanRows.find((row) => row.name === "invoke_agent workflow-label");
  assert.equal(root?.attrsTruncated, true);
  assert.equal(root?.attributes["ratel.sandbox.input"], INPUT);
  assert.equal(root?.attributes["ratel.sandbox.id"], "workflow-label");
  assert.equal(root?.attributes["ratel.replay.source_trace_id"], "f".repeat(32));
});

const PLAYGROUND = { "service.name": "ratel-cloud", "deployment.environment.name": "playground" };
const PRODUCTION = { "service.name": "ratel-cloud", "deployment.environment.name": "production" };

function context() {
  return { projectId: "p-1", organization: ORG, endpoint: "/v1/traces" };
}

function harness(sandboxesOn: boolean): { h: Harness; deps: PersistSpansDeps } {
  const h: Harness = { spanRows: [], costRows: [], traceEvents: [], flagReads: 0 };
  const deps = {
    insertEventsWithMetrics: async (_projectId: string, rows: unknown[]) => {
      h.costRows.push(...rows);
      return rows.length;
    },
    insertTraceEvents: async (_projectId: string, rows: ParsedTraceEvent[]) => {
      h.traceEvents.push(...rows);
      return { accepted: rows.length };
    },
    insertOtelSpans: async (_projectId: string, rows: OtelSpanRow[]) => {
      h.spanRows.push(...rows);
      return { accepted: rows.length };
    },
    traceTurns: {
      isEnabled: async () => true,
      enqueueBuild: async () => null,
      scheduleProjectDrain: () => {},
    },
    agentRunsEnabled: async () => true,
    sandboxesEnabled: async () => {
      h.flagReads += 1;
      return sandboxesOn;
    },
    agentSpanDedupe: null,
    logError: () => {},
    captureFailure: () => {},
  } as unknown as PersistSpansDeps;
  return { h, deps };
}

/** A sandbox run: an `invoke_agent` root, one model call and one tool call. */
function run(resourceAttributes: Record<string, string>): DecodedSpan[] {
  return [
    span({
      resourceAttributes,
      name: "invoke_agent workflow-label",
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "workflow-label",
        "gen_ai.conversation.id": "pg-session-1",
        "ratel.sandbox.id": "workflow-label",
        "ratel.sandbox.config_hash": "abc123",
        "ratel.sandbox.input": INPUT,
        "ratel.replay.source_trace_id": "f".repeat(32),
        "ratel.replay.arm": "candidate",
      },
    }),
    span({
      resourceAttributes,
      spanId: "2".repeat(16),
      parentSpanId: "1".repeat(16),
      name: "chat claude-sonnet-5-5",
      kind: 3,
      startUnixMs: 1_700_000_000_100,
      endUnixMs: 1_700_000_000_900,
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.request.model": "claude-sonnet-5-5",
        "gen_ai.conversation.id": "pg-session-1",
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 5,
      },
    }),
    span({
      resourceAttributes,
      spanId: "3".repeat(16),
      parentSpanId: "1".repeat(16),
      name: "execute_tool search",
      startUnixMs: 1_700_000_000_910,
      endUnixMs: 1_700_000_000_950,
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "search",
        "gen_ai.conversation.id": "pg-session-1",
      },
    }),
  ];
}

function span(overrides: Partial<DecodedSpan>): DecodedSpan {
  return {
    traceId: "a".repeat(32),
    spanId: "1".repeat(16),
    parentSpanId: null,
    name: "span",
    kind: 1,
    startUnixMs: 1_700_000_000_000,
    endUnixMs: 1_700_000_001_000,
    attributes: {},
    events: [],
    statusCode: 0,
    resourceAttributes: {},
    scopeName: "ratel-sandbox",
    ...overrides,
  };
}
