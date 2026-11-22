import assert from "node:assert/strict";
import { test } from "node:test";
import type { Organization } from "@/lib/platform/organizations";
import { type PersistSpansDeps, persistDecodedSpans } from "./ingest-spans";
import type { OtelSpanRow } from "./span-rows";
import type { DecodedSpan } from "./types";

/**
 * RC-740: an `invoke_agent` root that carries its ask (`gen_ai.input.messages`,
 * Ratel's own backend jobs, RC-722) keeps it in `otel_spans`, for every
 * organization. Other spans stay content-free.
 */

const ASK = JSON.stringify([
  { role: "user", parts: [{ type: "text", content: "label_workflows for project p-1" }] },
]);
const PROMPT = JSON.stringify([
  { role: "user", parts: [{ type: "text", content: "Name this workflow" }] },
]);
const ORG = { id: "org-a", slug: "org-a" } as Organization;

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
    resourceAttributes: { "service.name": "ratel-cloud" },
    scopeName: "ratel-cloud/model-calls",
    ...overrides,
  };
}

function run(): DecodedSpan[] {
  return [
    span({
      name: "invoke_agent label_workflows",
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "label_workflows",
        "gen_ai.conversation.id": "job-1",
        "gen_ai.input.messages": ASK,
      },
    }),
    span({
      spanId: "2".repeat(16),
      parentSpanId: "1".repeat(16),
      name: "chat claude-sonnet-4-5",
      kind: 3,
      startUnixMs: 1_700_000_000_100,
      endUnixMs: 1_700_000_000_900,
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.request.model": "claude-sonnet-4-5",
        "gen_ai.agent.name": "workflow_label",
        "gen_ai.input.messages": PROMPT,
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 5,
      },
    }),
  ];
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
  spans = run(),
  organization: Organization | null = ORG,
) {
  const result = await persistDecodedSpans(
    spans,
    { projectId: "project-1", organization, endpoint: "/v1/traces" },
    deps,
  );
  assert.ok(result.ok);
}

const root = (h: { spanRows: OtelSpanRow[] }) =>
  h.spanRows.find((row) => row.name.startsWith("invoke_agent"))!;
const chat = (h: { spanRows: OtelSpanRow[] }) =>
  h.spanRows.find((row) => row.name.startsWith("chat"))!;

test("the invoke_agent root keeps its ask; the chat span stays content-free", async () => {
  const { h, deps } = harness();
  await persist(deps);
  assert.equal(root(h).attributes["gen_ai.input.messages"], ASK);
  assert.equal(chat(h).attributes["gen_ai.input.messages"], undefined);
});

test("an invoke_agent span that is not the root keeps no content", async () => {
  const { h, deps } = harness();
  const [rootSpan, chatSpan] = run();
  await persist(deps, [{ ...rootSpan!, parentSpanId: "9".repeat(16) }, chatSpan!]);
  assert.equal(root(h).attributes["gen_ai.input.messages"], undefined);
});

test("a batch with no organization still keeps the ask", async () => {
  const { h, deps } = harness();
  await persist(deps, run(), null);
  assert.equal(root(h).attributes["gen_ai.input.messages"], ASK);
  assert.equal(h.spanRows.length, 2);
});
