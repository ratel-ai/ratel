import assert from "node:assert/strict";
import { test } from "node:test";
import { FOLD_MIN_INTERVAL_MS } from "@/lib/ingest/trace-events/fold-schedule";
import type { ParsedTraceEvent } from "@/lib/ingest/trace-events/parse";
import type { ApiKey } from "@/lib/platform/projects/schema";
import { decodeJson } from "./decode";
import { persistDecodedSpans } from "./ingest-spans";
import { handleTracesRequest, type TracesHandlerDeps } from "./route-handler";
import type { RuntimeInvoke } from "./runtime-duplicates";

/**
 * The Agent health bridge on the traces route: tool-call spans reach the turn
 * ledger when turn deps are wired, the build is enqueued, and a call the SDK
 * already recorded is never double counted, while another agent's runs and
 * every model call are kept.
 */

const KEY: ApiKey = {
  id: "key-1",
  projectId: "proj-1",
  name: "test",
  keyHash: "hash",
  keyPrefix: "rtl_abc",
  createdAt: new Date(),
  lastUsedAt: new Date(),
  revokedAt: null,
  expiresAt: null,
};

const START_NS = "1759233600000000000";
const END_NS = "1759233600300000000";

function attr(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

/** One agent run: a chat span and two tool spans, one of them failing. */
function agentRunJson(): string {
  const traceId = "c".repeat(32);
  const spans = [
    {
      traceId,
      spanId: "1".repeat(16),
      name: "chat claude",
      kind: 3,
      startTimeUnixNano: START_NS,
      endTimeUnixNano: END_NS,
      attributes: [
        attr("gen_ai.operation.name", "chat"),
        attr("gen_ai.request.model", "claude-sonnet-5"),
        attr(
          "gen_ai.input.messages",
          JSON.stringify([
            { role: "user", parts: [{ type: "text", content: "find my open tasks" }] },
          ]),
        ),
      ],
    },
    {
      traceId,
      spanId: "2".repeat(16),
      name: "execute_tool find_task",
      kind: 1,
      startTimeUnixNano: START_NS,
      endTimeUnixNano: END_NS,
      attributes: [
        attr("gen_ai.operation.name", "execute_tool"),
        attr("gen_ai.tool.name", "find_task"),
        attr("gen_ai.conversation.id", "conv-1"),
      ],
    },
    {
      traceId,
      spanId: "3".repeat(16),
      name: "execute_tool assign_task",
      kind: 1,
      startTimeUnixNano: START_NS,
      endTimeUnixNano: END_NS,
      status: { code: 2 },
      attributes: [
        attr("gen_ai.operation.name", "execute_tool"),
        attr("gen_ai.tool.name", "assign_task"),
        attr("gen_ai.conversation.id", "conv-1"),
      ],
    },
  ];
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [attr("service.name", "pm-agent")] },
        scopeSpans: [{ scope: { name: "x" }, spans }],
      },
    ],
  });
}

function setup(over: { invokes?: readonly RuntimeInvoke[] | Error; withTurns?: boolean } = {}) {
  const stored: ParsedTraceEvent[][] = [];
  const enqueued: string[] = [];
  const drained: string[] = [];
  const deps: TracesHandlerDeps = {
    isDbConfigured: () => true,
    hashApiKey: (s) => `hashed:${s}`,
    findActiveApiKeyByHash: async () => KEY,
    touchApiKey: async () => {},
    insertEventsWithMetrics: async (_p, rows) => rows.length,
    insertTraceEvents: async (_p, events) => {
      stored.push(events);
      return { accepted: events.length };
    },
    insertOtelSpans: async (_p, spans) => ({ accepted: spans.length }),
    shouldSampleRejection: () => true,
    logError: () => {},
    logWarn: () => {},
    findRuntimeInvokes: async () => {
      if (over.invokes instanceof Error) throw over.invokes;
      return over.invokes ?? [];
    },
    ...(over.withTurns === false
      ? {}
      : {
          traceTurns: {
            enqueueBuild: async (projectId: string) => {
              enqueued.push(projectId);
              return { id: "job-1" };
            },
            scheduleProjectDrain: (projectId: string) => {
              drained.push(projectId);
            },
          },
        }),
  };
  return { deps, stored, enqueued, drained };
}

function post(deps: TracesHandlerDeps): Promise<Response> {
  return handleTracesRequest(
    new Request("http://localhost/api/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer rtl_k" },
      body: agentRunJson(),
    }),
    deps,
  );
}

const modelCalls = (stored: ParsedTraceEvent[][]) =>
  stored.flat().filter((e) => e.type === "otlp_model_call");
const invokes = (stored: ParsedTraceEvent[][]) =>
  stored.flat().filter((e) => e.type === "invoke_end" || e.type === "invoke_error");

test("with turn-ledger deps, tool spans become ledger invocations and a build is enqueued", async () => {
  const { deps, stored, enqueued, drained } = setup();
  const res = await post(deps);
  assert.equal(res.status, 202);
  const rows = invokes(stored);
  assert.deepEqual(
    rows.map((r) => [r.toolId, r.type, r.sessionId]),
    [
      ["find_task", "invoke_end", "conv-1"],
      ["assign_task", "invoke_error", "conv-1"],
    ],
  );
  assert.equal(modelCalls(stored).length, 1, "one model round trip beside the steps");
  assert.equal(
    modelCalls(stored)[0].sessionId,
    "c".repeat(32),
    "the chat span carries no conversation id",
  );
  assert.deepEqual(enqueued, ["proj-1"]);
  assert.deepEqual(drained, ["proj-1"]);
});

const SPAN_AT_MS = Number(START_NS.slice(0, -6));

test("a tool call the SDK already recorded in the same session is dropped; the rest stay", async () => {
  const { deps, stored } = setup({
    invokes: [{ sessionId: "conv-1", toolId: "find_task", at: new Date(SPAN_AT_MS + 1_200) }],
  });
  assert.equal((await post(deps)).status, 202);
  assert.deepEqual(
    invokes(stored).map((r) => r.toolId),
    ["assign_task"],
  );
  assert.equal(modelCalls(stored).length, 1, "model calls are always kept");
});

test("a second, OTel-only agent in the project keeps its runs", async () => {
  const { deps, stored } = setup({
    invokes: [
      { sessionId: "sdk-session-9", toolId: "find_task", at: new Date(SPAN_AT_MS) },
      { sessionId: "conv-1", toolId: "find_task", at: new Date(SPAN_AT_MS + 60_000) },
    ],
  });
  assert.equal((await post(deps)).status, 202);
  assert.deepEqual(
    invokes(stored).map((r) => r.toolId),
    ["find_task", "assign_task"],
  );
});

test("model calls are kept even when every tool call is a duplicate", async () => {
  const { deps, stored } = setup({
    invokes: [
      { sessionId: "conv-1", toolId: "find_task", at: new Date(SPAN_AT_MS) },
      { sessionId: "conv-1", toolId: "assign_task", at: new Date(SPAN_AT_MS - 4_000) },
    ],
  });
  assert.equal((await post(deps)).status, 202);
  assert.equal(invokes(stored).length, 0);
  assert.equal(modelCalls(stored).length, 1);
});

test("a failing duplicate check keeps every row", async () => {
  const { deps, stored } = setup({ invokes: new Error("db down") });
  assert.equal((await post(deps)).status, 202);
  assert.equal(invokes(stored).length, 2);
  assert.equal(modelCalls(stored).length, 1);
});

/* — the Cloud-built intent graph learns from the same rows ———————————————— */

function withFold(deps: TracesHandlerDeps) {
  const folds: Array<{ projectId: string; minIntervalMs?: number }> = [];
  const drained: string[] = [];
  Object.assign(deps, {
    enqueueFoldIntentGraphJob: async (
      projectId: string,
      _db?: unknown,
      options?: { minIntervalMs?: number },
    ) => {
      folds.push({ projectId, minIntervalMs: options?.minIntervalMs });
      return { id: "fold-1" };
    },
    scheduleProjectDrain: (projectId: string) => {
      drained.push(projectId);
    },
  });
  return { folds, drained };
}

test("an export derives the rows the graph learns from and enqueues a paced fold", async () => {
  const { deps, stored, enqueued } = setup();
  const { folds, drained } = withFold(deps);
  assert.equal((await post(deps)).status, 202);
  assert.equal(invokes(stored).length, 2, "tool calls are derived for the graph");
  assert.equal(modelCalls(stored).length, 1);
  assert.equal(modelCalls(stored)[0]?.payload.prompt, "find my open tasks");
  assert.deepEqual(folds, [{ projectId: KEY.projectId, minIntervalMs: FOLD_MIN_INTERVAL_MS }]);
  assert.ok(drained.includes(KEY.projectId));
  assert.deepEqual(enqueued, [KEY.projectId], "the turn build is enqueued too");
});

test("the importer stores the same rows but leaves the fold to the cron safety net", async () => {
  const { deps, stored } = setup();
  const { folds } = withFold(deps);
  const result = await persistDecodedSpans(
    decodeJson(new TextEncoder().encode(agentRunJson())),
    {
      projectId: KEY.projectId,
      organization: null,
      endpoint: "health_import",
      foldIntentGraph: false,
    },
    { ...deps, logError: () => {}, captureFailure: () => {} },
  );
  assert.equal(result.ok, true);
  assert.equal(invokes(stored).length, 2, "tool calls are derived for the graph");
  assert.equal(modelCalls(stored).length, 1);
  assert.deepEqual(folds, [], "an import does not kick a fold");
});

test("without turn-ledger deps nothing is derived and no fold is enqueued", async () => {
  const off = setup({ withTurns: false });
  const offFold = withFold(off.deps);
  assert.equal((await post(off.deps)).status, 202);
  assert.deepEqual(offFold.folds, []);
  assert.equal(off.stored.flat().length, 0);
  assert.deepEqual(off.enqueued, []);
});
