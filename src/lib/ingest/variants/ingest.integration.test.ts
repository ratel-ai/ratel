import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { type PersistSpansDeps, persistDecodedSpans } from "@/lib/ingest/otlp/ingest-spans";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import { type NewOtelSpan, otelSpans } from "@/lib/ingest/otlp/schema";
import type { DecodedSpan } from "@/lib/ingest/otlp/types";
import type { VariantMapping } from "@/lib/ingest/variants/domain/mappings";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { otelTraceSummaries } from "@/lib/synthesis/traces/schema";
import {
  refreshTraceSummaries,
  type TraceSummaryRefreshDb,
} from "@/lib/synthesis/traces/summary-refresh";

/** RC-868: ingest keeps `ratel.variant.*` per span, and the summary sweep rolls it up per trace. */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TRACE_ID = "a".repeat(32);

type TestDb = TraceSummaryRefreshDb &
  NonNullable<Parameters<typeof insertOtelSpans>[2]> &
  Pick<ReturnType<typeof getDb>, "select">;

const ROOT: DecodedSpan = {
  traceId: TRACE_ID,
  spanId: "1".repeat(16),
  parentSpanId: null,
  name: "invoke_agent checkout",
  kind: 1,
  startUnixMs: 1_790_000_000_000,
  endUnixMs: 1_790_000_001_000,
  attributes: {
    "gen_ai.operation.name": "invoke_agent",
    "ratel.variant.experiment": "checkout-model",
    "ratel.variant.name": "b",
    "ratel.variant.model": "claude-haiku-5-5",
  },
  events: [],
  statusCode: 1,
  resourceAttributes: { "service.name": "checkout-agent" },
  scopeName: "agent",
};

const CHILD: DecodedSpan = {
  ...ROOT,
  spanId: "2".repeat(16),
  parentSpanId: ROOT.spanId,
  name: "chat claude-haiku-5-5",
  kind: 3,
  startUnixMs: ROOT.startUnixMs + 100,
  endUnixMs: ROOT.startUnixMs + 600,
  attributes: { "gen_ai.operation.name": "chat", "gen_ai.request.model": "claude-haiku-5-5" },
};

test("flag on: only the root is tagged, and the trace summary has its experiment, name and descriptors", async () => {
  const { client, db } = await ingest(true);

  const spans = await db
    .select({
      spanId: otelSpans.spanId,
      experiment: otelSpans.variantExperiment,
      name: otelSpans.variantName,
    })
    .from(otelSpans)
    .orderBy(otelSpans.spanId);
  assert.deepEqual(spans, [
    { spanId: ROOT.spanId, experiment: "checkout-model", name: "b" },
    { spanId: CHILD.spanId, experiment: null, name: null },
  ]);
  const [summary] = await readSummary(db);
  assert.deepEqual(summary, {
    variantExperiment: "checkout-model",
    variantName: "b",
    variantAttrs: { model: "claude-haiku-5-5" },
  });
  await client.close();
});

test("flag off: no span and no summary has a variant", async () => {
  const { client, db } = await ingest(false);

  const spans = await db
    .select({
      experiment: otelSpans.variantExperiment,
      name: otelSpans.variantName,
      attrs: otelSpans.variantAttrs,
    })
    .from(otelSpans);
  assert.deepEqual(spans, [
    { experiment: null, name: null, attrs: {} },
    { experiment: null, name: null, attrs: {} },
  ]);
  assert.deepEqual(await readSummary(db), [
    { variantExperiment: null, variantName: null, variantAttrs: {} },
  ]);
  await client.close();
});

test("flag on: a trace tagged only with a mapped app.variant is stored as that variant of the mapped experiment", async () => {
  const root = {
    ...ROOT,
    attributes: { "gen_ai.operation.name": "invoke_agent", "app.variant": "b" },
  };
  const { client, db } = await ingest(
    true,
    [root, CHILD],
    [{ attributeKey: "app.variant", experiment: "checkout-model" }],
  );

  assert.deepEqual(await readSummary(db), [
    { variantExperiment: "checkout-model", variantName: "b", variantAttrs: {} },
  ]);
  await client.close();
});

async function ingest(
  variants: boolean,
  spans: DecodedSpan[] = [ROOT, CHILD],
  mappings: ReadonlyArray<VariantMapping> = [],
) {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
  `);
  const db = drizzle(client, { schema }) as unknown as TestDb;
  const deps = {
    insertEventsWithMetrics: async (_projectId: string, rows: unknown[]) => rows.length,
    insertTraceEvents: async (_projectId: string, rows: unknown[]) => ({ accepted: rows.length }),
    insertOtelSpans: (projectId: string, rows: NewOtelSpan[]) =>
      insertOtelSpans(projectId, rows, db),
    variantsEnabled: async () => variants,
    loadVariantMappings: async () => mappings,
    agentSpanDedupe: null,
    logError: (message: string, err: unknown) => {
      throw new Error(`${message}: ${String(err)}`);
    },
    captureFailure: (err: unknown) => {
      throw err;
    },
  } as unknown as PersistSpansDeps;
  const result = await persistDecodedSpans(
    spans,
    { projectId: PROJECT_ID, organization: null, endpoint: "/v1/traces" },
    deps,
  );
  assert.ok(result.ok);
  await refreshTraceSummaries({ visibilityLagMs: 0 }, db);
  return { client, db };
}

function readSummary(db: TestDb) {
  return db
    .select({
      variantExperiment: otelTraceSummaries.variantExperiment,
      variantName: otelTraceSummaries.variantName,
      variantAttrs: otelTraceSummaries.variantAttrs,
    })
    .from(otelTraceSummaries);
}
