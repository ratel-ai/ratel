import assert from "node:assert/strict";
import { test } from "node:test";
import type { Organization } from "@/lib/platform/organizations";
import { type PersistSpansDeps, persistDecodedSpans } from "./ingest-spans";
import type { OtelSpanRow } from "./span-rows";
import type { DecodedSpan } from "./types";

/** AOBS-7: an `otel_spans` row keeps its span's events and links. */

const ORG = { id: "org-a", slug: "org-a" } as Organization;
const HOOK = {
  name: "ratel.hook",
  timeUnixMs: 1_700_000_000_100,
  attributes: { "ratel.hook.name": "PreToolUse", "ratel.hook.duration_ms": 12 },
};
const LINK = {
  traceId: "c".repeat(32),
  spanId: "d".repeat(16),
  attributes: { "ratel.link.kind": "background_task" },
};

function root(overrides: Partial<DecodedSpan> = {}): DecodedSpan {
  return {
    traceId: "b".repeat(32),
    spanId: "3".repeat(16),
    parentSpanId: null,
    name: "invoke_agent claude",
    kind: 1,
    startUnixMs: 1_700_000_000_000,
    endUnixMs: 1_700_000_000_200,
    attributes: { "gen_ai.operation.name": "invoke_agent" },
    events: [HOOK],
    links: [LINK],
    statusCode: 0,
    resourceAttributes: { "service.name": "beluga" },
    scopeName: "beluga",
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

async function persist(deps: PersistSpansDeps, spans: DecodedSpan[]) {
  const result = await persistDecodedSpans(
    spans,
    { projectId: "project-1", organization: ORG, endpoint: "/v1/traces" },
    deps,
  );
  assert.ok(result.ok);
}

test("the row keeps the span's events and links", async () => {
  const { h, deps } = harness();
  await persist(deps, [root()]);
  assert.deepEqual(h.spanRows[0].events, [HOOK]);
  assert.deepEqual(h.spanRows[0].links, [LINK]);
});

test("a span with no event and no link stores neither", async () => {
  const { h, deps } = harness();
  await persist(deps, [root({ events: [], links: [] })]);
  assert.equal(h.spanRows[0].events, null);
  assert.equal(h.spanRows[0].links, null);
});
