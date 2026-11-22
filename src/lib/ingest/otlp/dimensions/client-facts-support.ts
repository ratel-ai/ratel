import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { insertEventsWithMetrics, insertOtelSpans } from "@/lib/ingest/otlp/queries";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import type { ApiKey } from "@/lib/platform/projects/schema";
import {
  type Db,
  PROJECT_ID,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { clientSessionStore } from "../client-session-store";
import type { PersistSpansDeps } from "../ingest-spans";
import { handleTracesRequest, type TracesHandlerDeps } from "../route-handler";

/**
 * Test support for client facts end to end (RC-773, RC-774, RC-778): build
 * OTLP/JSON exports of MCP server spans and POST them to the traces route
 * against a migrated database, one request per export. Owned: the core's key
 * row has no plaintext column and a `created_by`; the turn kick has no flag.
 */

const KEY: ApiKey = {
  id: "key-1",
  projectId: PROJECT_ID,
  name: "test",
  keyHash: "hash",
  keyPrefix: "rtl_abc",
  createdAt: new Date(),
  lastUsedAt: new Date(),
  revokedAt: null,
  expiresAt: null,
  scopes: ["*"],
  rateLimitPerMinute: null,
  createdBy: null,
};

export type Attr = Record<string, string>;

export interface SpanSpec {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startMs: number;
  endMs: number;
  attributes: Attr;
}

export const BASE_MS = Date.parse("2026-11-17T10:00:00Z");

/** One export of `service`'s spans; times are offsets from {@link BASE_MS} (or `baseMs`). */
export function otlp(spans: SpanSpec[], service = "weather-mcp", baseMs = BASE_MS): string {
  const kv = (attrs: Attr) =>
    Object.entries(attrs).map(([key, value]) => ({ key, value: { stringValue: value } }));
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: kv({ "service.name": service }) },
        scopeSpans: [
          {
            scope: { name: "@modelcontextprotocol/server" },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: s.kind,
              startTimeUnixNano: `${baseMs + s.startMs}000000`,
              endTimeUnixNano: `${baseMs + s.endMs}000000`,
              attributes: kv(s.attributes),
            })),
          },
        ],
      },
    ],
  });
}

export type RouteDeps = TracesHandlerDeps & Pick<PersistSpansDeps, "agentRunsEnabled">;

export function routeDeps(db: Db, overrides: Partial<RouteDeps> = {}): TracesHandlerDeps {
  const deps: RouteDeps = {
    scope: "ingest:traces",
    isDbConfigured: () => true,
    hashApiKey: (s) => `hashed:${s}`,
    findActiveApiKeyByHash: async () => KEY,
    touchApiKey: async () => {},
    insertEventsWithMetrics: (projectId, rows) => insertEventsWithMetrics(projectId, rows, db),
    insertTraceEvents: (projectId, events) => insertTraceEvents(projectId, events, db),
    insertOtelSpans: (projectId, rows) => insertOtelSpans(projectId, rows, db),
    clientSessions: clientSessionStore(db),
    shouldSampleRejection: () => true,
    logError: (message, err) => assert.fail(`${message}: ${String(err)}`),
    logWarn: () => {},
    traceTurns: {
      enqueueBuild: async () => null,
      scheduleProjectDrain: () => {},
    },
    agentRunsEnabled: async () => true,
    agentSpanDedupe: { findTracesWithModelCalls: async () => new Set<string>() },
    ...overrides,
  };
  return deps;
}

/** POST each body as its own request, in order. */
export async function ingest(
  bodies: readonly string[],
  overrides: Partial<RouteDeps> = {},
): Promise<{ client: PGlite; db: Db }> {
  const { client, db } = await setupDb();
  await post(db, bodies, overrides);
  return { client, db };
}

export async function post(
  db: Db,
  bodies: readonly string[],
  overrides: Partial<RouteDeps> = {},
): Promise<void> {
  for (const body of bodies) {
    const res = await handleTracesRequest(
      new Request("http://localhost/api/v1/traces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer rtl_k" },
        body,
      }),
      routeDeps(db, overrides),
    );
    assert.equal(res.status, 202);
  }
}
