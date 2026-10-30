import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import type { NewOtelSpan } from "@/lib/ingest/otlp/schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { otelTraceSummaries } from "@/lib/synthesis/traces/schema";
import { refreshTraceSummaries, type TraceSummaryRefreshDb } from "./summary-refresh";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

type TestDb = TraceSummaryRefreshDb &
  NonNullable<Parameters<typeof insertOtelSpans>[2]> &
  Pick<ReturnType<typeof getDb>, "select">;

// `received_at` defaults to `now()`: every span of one export shares one microsecond timestamp.
// A cursor kept at millisecond precision sits before that timestamp and re-reads the same spans.
test("spans that share a microsecond receipt time are swept once, then the sweep catches up", async () => {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
    values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
  `);
  const db = drizzle(client, { schema }) as unknown as TestDb;
  await insertOtelSpans(
    PROJECT_ID,
    [1, 2, 3, 4, 5].map((n) => span(n)),
    db,
  );
  await client.exec(`update otel_spans set received_at = '2026-07-30 08:00:02.123456+00'`);

  const result = await refreshTraceSummaries(
    { visibilityLagMs: 0, batchSize: 2, timeBudgetMs: 2_000 },
    db,
  );

  assert.equal(result.caughtUp, true);
  assert.equal(result.spansScanned, 5);
  assert.equal((await db.select().from(otelTraceSummaries)).length, 5);
});

function span(n: number): NewOtelSpan {
  const hex = n.toString(16);
  const startedAt = new Date("2026-07-30T10:00:00.000Z");
  return {
    id: `00000000-0000-8000-8000-${hex.padStart(12, "0")}`,
    projectId: PROJECT_ID,
    traceId: hex.padStart(32, "0"),
    spanId: hex.padStart(16, "0"),
    parentSpanId: null,
    name: "agent.run",
    kind: 1,
    spanClass: "other",
    startedAt,
    endedAt: new Date(startedAt.getTime() + 100),
    durationMs: 100,
    statusCode: 1,
    serviceName: "fixture-agent",
    scopeName: "fixture",
    operationName: null,
    providerName: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
    costUsd: null,
    searchOrigin: null,
    searchTarget: null,
    searchQuery: null,
    searchTopK: null,
    searchHitCount: null,
    experimentName: null,
    experimentArm: null,
    experimentRole: null,
    experimentAttrs: {},
    attributes: {},
    attrsTruncated: false,
  };
}
