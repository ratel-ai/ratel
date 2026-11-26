import assert from "node:assert/strict";
import {
  findTracesWithModelCalls,
  insertEventsWithMetrics,
  insertOtelSpans,
} from "@/lib/ingest/otlp/queries";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import type { ApiKey } from "@/lib/platform/projects/schema";
import { type Db, PROJECT_ID } from "@/lib/readings/trace-signals/signals/integration-support";
import { handleTracesRequest, type TracesHandlerDeps } from "./route-handler";

/**
 * The session and end-user export the RTL-321 integration tests share: one trace
 * whose root carries `session.id` and `user.id` above a model call, and one
 * trace with neither. {@link ingestSessionUserExport} POSTs it to the traces route.
 */

export const TRACE = "5b8efff798038103d269b633813fc60c";
export const BARE_TRACE = "6c9f0008a9149214e37ac744924fd71d";
export const [ROOT, CHAT, BARE] = ["1111111111111111", "2222222222222222", "3333333333333333"];

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
};

type Attr = { key: string; value: { stringValue?: string; intValue?: string } };

const str = (key: string, value: string): Attr => ({ key, value: { stringValue: value } });
const int = (key: string, value: number): Attr => ({ key, value: { intValue: String(value) } });

function chatSpan(traceId: string, spanId: string, parentSpanId?: string) {
  return {
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name: "chat claude-sonnet-5",
    kind: 3,
    startTimeUnixNano: "1794000000100000000",
    endTimeUnixNano: "1794000000300000000",
    attributes: [
      str("gen_ai.operation.name", "chat"),
      str("gen_ai.provider.name", "anthropic"),
      str("gen_ai.request.model", "claude-sonnet-5"),
      int("gen_ai.usage.input_tokens", 10),
      int("gen_ai.usage.output_tokens", 5),
    ],
    status: {},
  };
}

/** One trace whose root carries the session and the user, and one trace with neither. */
const EXPORT = {
  resourceSpans: [
    {
      resource: { attributes: [str("service.name", "support-app")] },
      scopeSpans: [
        {
          scope: { name: "support-app" },
          spans: [
            {
              traceId: TRACE,
              spanId: ROOT,
              name: "invoke_agent supervisor",
              kind: 1,
              startTimeUnixNano: "1794000000000000000",
              endTimeUnixNano: "1794000000900000000",
              attributes: [
                str("gen_ai.operation.name", "invoke_agent"),
                str("gen_ai.agent.name", "supervisor"),
                str("session.id", "conv-42"),
                str("user.id", "user-7"),
              ],
              status: {},
            },
            chatSpan(TRACE, CHAT, ROOT),
            chatSpan(BARE_TRACE, BARE),
          ],
        },
      ],
    },
  ],
};

export async function ingestSessionUserExport(db: Db): Promise<void> {
  const deps: TracesHandlerDeps = {
    scope: "ingest:traces",
    isDbConfigured: () => true,
    hashApiKey: (s) => `hashed:${s}`,
    findActiveApiKeyByHash: async () => KEY,
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
  };
  const res = await handleTracesRequest(
    new Request("http://localhost/api/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer rtl_k" },
      body: JSON.stringify(EXPORT),
    }),
    deps,
  );
  assert.equal(res.status, 202);
}
