import assert from "node:assert/strict";
import {
  findTracesWithModelCalls,
  insertEventsWithMetrics,
  insertOtelSpans,
} from "@/lib/ingest/otlp/queries";
import { handleTracesRequest, type TracesHandlerDeps } from "@/lib/ingest/otlp/route-handler";
import { createOtlpRawStore } from "@/lib/ingest/otlp-raw/store";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import type { ApiKey } from "@/lib/platform/projects/schema";
import { type Db, PROJECT_ID } from "@/lib/readings/trace-signals/signals/integration-support";
import { createPropertyIngest } from "./ingest";
import { loadIndexedProperties, recordPropertyKeys } from "./store";

/**
 * The trace property export the RTL-395 integration tests share: a root span with the standard
 * organization (`tenant.id`), the user and a key of the user's own (`app.plan`), a child span with
 * other values for both, and a resource with the release (`service.version`).
 */

export const ROOT = "1111111111111111";
export const CHILD = "2222222222222222";

type Attr = { key: string; value: { stringValue?: string; intValue?: string } };

const str = (key: string, value: string): Attr => ({ key, value: { stringValue: value } });

export function propertyExport(traceId: string, plan = "pro") {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [str("service.name", "support-app"), str("service.version", "1.2.3")],
        },
        scopeSpans: [
          {
            scope: { name: "support-app" },
            spans: [
              {
                traceId,
                spanId: ROOT,
                name: "invoke_agent supervisor",
                kind: 1,
                startTimeUnixNano: "1794000000000000000",
                endTimeUnixNano: "1794000000900000000",
                attributes: [
                  str("gen_ai.operation.name", "invoke_agent"),
                  str("tenant.id", "acme"),
                  str("user.id", "user-7"),
                  str("app.plan", plan),
                ],
                status: {},
              },
              {
                traceId,
                spanId: CHILD,
                parentSpanId: ROOT,
                name: "lookup",
                kind: 1,
                startTimeUnixNano: "1794000000100000000",
                endTimeUnixNano: "1794000000300000000",
                attributes: [str("customer.id", "other"), str("app.plan", "free")],
                status: {},
              },
            ],
          },
        ],
      },
    ],
  };
}

/** A property ingest on this database, with no cache between exports. */
export function testPropertyIngest(db: Db) {
  let now = 0;
  return createPropertyIngest({
    record: (projectId, sightings) => recordPropertyKeys(projectId, sightings, db),
    indexed: (projectId) => loadIndexedProperties(projectId, db),
    // Every export is an hour later: nothing is cached.
    now: () => {
      now += 2 * 60 * 60_000;
      return now;
    },
  });
}

/** POST the export to the traces route, with the raw body kept, as the project's key. */
export async function ingestPropertyExport(
  db: Db,
  body: unknown,
  options: { projectId?: string; properties?: TracesHandlerDeps["properties"] } = {},
): Promise<void> {
  const key: ApiKey = {
    id: "key-1",
    projectId: options.projectId ?? PROJECT_ID,
    name: "test",
    keyHash: "hash",
    keyPrefix: "rtl_abc",
    createdAt: new Date(),
    lastUsedAt: new Date(),
    revokedAt: null,
    expiresAt: null,
    scopes: ["*"],
    rateLimitPerMinute: null,
  };
  const deps: TracesHandlerDeps = {
    scope: "ingest:traces",
    isDbConfigured: () => true,
    hashApiKey: (s) => `hashed:${s}`,
    findActiveApiKeyByHash: async () => key,
    touchApiKey: async () => {},
    insertEventsWithMetrics: (projectId, rows) => insertEventsWithMetrics(projectId, rows, db),
    insertTraceEvents: (projectId, events) => insertTraceEvents(projectId, events, db),
    insertOtelSpans: (projectId, rows) => insertOtelSpans(projectId, rows, db),
    shouldSampleRejection: () => true,
    logError: (message, err) => assert.fail(`${message}: ${String(err)}`),
    logWarn: () => {},
    traceTurns: { enqueueBuild: async () => null, scheduleProjectDrain: () => {} },
    agentSpanDedupe: {
      findTracesWithModelCalls: (projectId, traceIds) =>
        findTracesWithModelCalls(projectId, traceIds, db),
    },
    otlpRawCapture: { store: createOtlpRawStore({ db, dailyCapBytes: 10_000_000 }) },
    ...(options.properties ? { properties: options.properties } : {}),
  };
  const res = await handleTracesRequest(
    new Request("http://localhost/api/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer rtl_k" },
      body: JSON.stringify(body),
    }),
    deps,
  );
  assert.equal(res.status, 202);
}
