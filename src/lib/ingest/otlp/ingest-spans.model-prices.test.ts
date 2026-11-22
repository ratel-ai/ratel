import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventWithMetric } from "@/lib/ingest/otlp/queries";
import { claudeAgentSdkTrace } from "./agent-span-fixtures";
import { type PersistSpansDeps, persistDecodedSpans } from "./ingest-spans";
import type { OtelSpanRow } from "./span-rows";

/**
 * RC-482: a batch pays the current prices and the project's own, read once
 * per batch. When the read fails, the batch stores no cost, so
 * `backfill:costs` prices it later.
 */

const CHAT_SPAN = "2000000000000002";
// claude-sonnet-4-5 at the project's price: $10 in, $0 cached, $100 out.
// The first chat: 400 in (200 cached), 80 out: (200 * 10 + 80 * 100) / 1M.
const OWN_PRICE = { "claude-sonnet-4-5": { input: 10, output: 100, cachedInput: 0 } };
function harness(modelPricing?: { overrides: () => Promise<typeof OWN_PRICE> }) {
  const h = {
    spanRows: [] as OtelSpanRow[],
    eventRows: [] as EventWithMetric[],
    errors: [] as string[],
    reads: 0,
  };
  const deps = {
    insertEventsWithMetrics: async (_projectId: string, rows: EventWithMetric[]) => {
      h.eventRows.push(...rows);
      return rows.length;
    },
    insertTraceEvents: async (_projectId: string, rows: unknown[]) => ({ accepted: rows.length }),
    insertOtelSpans: async (_projectId: string, rows: OtelSpanRow[]) => {
      h.spanRows.push(...rows);
      return { accepted: rows.length };
    },
    modelPricing: modelPricing && {
      loadOverrides: async () => {
        h.reads += 1;
        return modelPricing.overrides();
      },
    },
    logError: (message: string) => h.errors.push(message),
    captureFailure: () => {},
  } as unknown as PersistSpansDeps;
  return { h, deps };
}

async function persist(deps: PersistSpansDeps) {
  const result = await persistDecodedSpans(
    claudeAgentSdkTrace(),
    { projectId: "project-1", organization: null, endpoint: "/v1/traces" },
    deps,
  );
  assert.ok(result.ok);
}

const chatSpan = (h: { spanRows: OtelSpanRow[] }) =>
  h.spanRows.find((row) => row.spanId === CHAT_SPAN);
const chatEvent = (h: { eventRows: EventWithMetric[] }) =>
  h.eventRows.find((row) => row.event.spanId === CHAT_SPAN);

test("a batch's spans and events pay the project's own price, read once", async () => {
  const { h, deps } = harness({ overrides: async () => OWN_PRICE });
  await persist(deps);
  assert.equal(h.reads, 1);
  assert.equal(chatSpan(h)?.costUsd, "0.01");
  assert.equal(chatEvent(h)?.event.costUsd, "0.01");
});

test("with no price of its own a batch pays the current built-in price", async () => {
  const { h, deps } = harness({ overrides: async () => ({}) as typeof OWN_PRICE });
  await persist(deps);
  // claude-sonnet-4-5: $3 in, $0.30 cached, $15 out: (200 * 3 + 200 * 0.3 + 80 * 15) / 1M.
  assert.equal(chatSpan(h)?.costUsd, "0.00186");
  assert.deepEqual(h.errors, []);
});

test("a failed price read: no cost is stored and the error is logged, for backfill:costs to price", async () => {
  const { h, deps } = harness({
    overrides: async () => {
      throw new Error("db down");
    },
  });
  await persist(deps);
  assert.equal(chatSpan(h)?.costUsd, null);
  assert.equal(chatEvent(h)?.event.costUsd, null);
  assert.equal(chatEvent(h)?.metric.costUsd, null);
  assert.deepEqual(h.errors, ["model price read failed"]);
});

test("without the model pricing deps a batch pays the current built-in prices", async () => {
  const { h, deps } = harness();
  await persist(deps);
  assert.equal(chatSpan(h)?.costUsd, "0.00186");
});

test("an unpriced call stores the cost its emitter sent (AOBS-3)", async () => {
  const { h, deps } = harness({ overrides: async () => ({}) as typeof OWN_PRICE });
  const spans = claudeAgentSdkTrace().map((span) =>
    span.spanId === CHAT_SPAN
      ? {
          ...span,
          attributes: {
            ...span.attributes,
            "gen_ai.request.model": "my-own-model",
            "gen_ai.response.model": "my-own-model",
            "ratel.usage.cost_usd": 0.0421,
          },
        }
      : span,
  );
  const result = await persistDecodedSpans(
    spans,
    { projectId: "project-1", organization: null, endpoint: "/v1/traces" },
    deps,
  );
  assert.ok(result.ok);
  assert.equal(chatSpan(h)?.costUsd, "0.0421");
  assert.equal(chatEvent(h)?.event.costUsd, "0.0421");
});
