import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventWithMetric } from "@/lib/ingest/otlp/queries";
import { type PersistSpansDeps, persistDecodedSpans } from "../ingest-spans";
import type { OtelSpanRow } from "../span-rows";
import type { DecodedSpan } from "../types";

/** `persistDecodedSpans` reads the OpenLLMetry aliases onto the canonical keys. */

interface Stored {
  events: EventWithMetric[];
  spans: OtelSpanRow[];
}

function deps(stored: Stored): PersistSpansDeps {
  return {
    insertEventsWithMetrics: async (_projectId, rows) => {
      stored.events.push(...(rows as EventWithMetric[]));
      return rows.length;
    },
    insertTraceEvents: async (_projectId, rows) => ({ accepted: rows.length }),
    insertOtelSpans: async (_projectId, rows) => {
      stored.spans.push(...(rows as OtelSpanRow[]));
      return { accepted: rows.length };
    },
    logError: () => {},
    captureFailure: () => {},
  };
}

function openLlmetrySpan(): DecodedSpan {
  const start = Date.UTC(2026, 10, 1);
  return {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    parentSpanId: null,
    name: "anthropic.chat",
    kind: 3,
    startUnixMs: start,
    endUnixMs: start + 800,
    attributes: {
      "gen_ai.system": "anthropic",
      "gen_ai.request.model": "claude-sonnet-5",
      "gen_ai.usage.prompt_tokens": 1_000,
      "gen_ai.usage.completion_tokens": 200,
      "gen_ai.usage.cache_read_input_tokens": 900,
    },
    events: [],
    statusCode: 0,
    resourceAttributes: { "service.name": "agent", "deployment.environment.name": "prod" },
    scopeName: "opentelemetry.instrumentation.anthropic",
  };
}

async function persist(): Promise<Stored> {
  const stored: Stored = { events: [], spans: [] };
  const result = await persistDecodedSpans(
    [openLlmetrySpan()],
    { projectId: "project-1", organization: null, endpoint: "/v1/traces" },
    deps(stored),
  );
  assert.ok(result.ok);
  return stored;
}

test("events and otel_spans carry the OpenLLMetry cached tokens", async () => {
  const { events, spans } = await persist();
  assert.equal(events.length, 1);
  assert.equal(events[0].event.cachedTokens, 900);
  assert.equal(events[0].event.inputTokens, 1_000);
  assert.equal(events[0].event.provider, "anthropic");
  assert.equal(spans[0].cachedTokens, 900);
  assert.equal(spans[0].providerName, "anthropic");
  assert.equal(spans[0].attributes["deployment.environment.name"], "prod");
});
