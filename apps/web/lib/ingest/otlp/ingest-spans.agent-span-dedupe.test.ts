import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSpanDedupeDeps } from "./agent-span-dedupe";
import { agentOnlyTrace, LANGGRAPH_TRACE, langGraphTrace } from "./agent-span-fixtures";
import { type PersistSpansDeps, persistDecodedSpans } from "./ingest-spans";
import type { OtelSpanRow } from "./span-rows";
import type { DecodedSpan } from "./types";

interface Harness {
  deps: PersistSpansDeps;
  spanRows: OtelSpanRow[];
  lookups: string[][];
  errors: string[];
  failures: unknown[];
}

function harness(dedupe?: Partial<AgentSpanDedupeDeps> & { stored?: string[] }): Harness {
  const h: Harness = {
    deps: {} as PersistSpansDeps,
    spanRows: [],
    lookups: [],
    errors: [],
    failures: [],
  };
  h.deps = {
    insertEventsWithMetrics: async (_projectId, rows) => rows.length,
    insertTraceEvents: async (_projectId, rows) => ({ accepted: rows.length }),
    insertOtelSpans: async (_projectId, rows) => {
      h.spanRows.push(...(rows as OtelSpanRow[]));
      return { accepted: rows.length };
    },
    logError: (message) => h.errors.push(message),
    captureFailure: (err) => h.failures.push(err),
    ...(dedupe && {
      agentSpanDedupe: {
        findTracesWithModelCalls: async (_projectId, traceIds) => {
          h.lookups.push(traceIds);
          return new Set(traceIds.filter((id) => dedupe.stored?.includes(id)));
        },
        ...dedupe,
      },
    }),
  } as PersistSpansDeps;
  return h;
}

async function persist(spans: DecodedSpan[], h: Harness) {
  const result = await persistDecodedSpans(
    spans,
    { projectId: "project-1", organization: null, endpoint: "/v1/traces" },
    h.deps,
  );
  assert.ok(result.ok);
  return result.calls;
}

test("a full LangGraph batch stores 2 calls and no storage lookup", async () => {
  const h = harness({});
  assert.equal(await persist(langGraphTrace(), h), 2);
  assert.deepEqual(h.lookups, []);
  assert.equal(h.spanRows[0].spanClass, "other");
  assert.equal(h.spanRows[0].inputTokens, null);
});

test("without the storage lookup wired, the LangGraph root is a third call", async () => {
  assert.equal(await persist(langGraphTrace(), harness()), 3);
});

test("a root exported after its stored model calls is not counted", async () => {
  const h = harness({ stored: [LANGGRAPH_TRACE] });
  assert.equal(await persist(langGraphTrace().slice(0, 1), h), 0);
  assert.deepEqual(h.lookups, [[LANGGRAPH_TRACE]]);
  assert.equal(h.spanRows[0].spanClass, "other");
  assert.equal(h.spanRows[0].costUsd, null);
});

test("a root with no model call in batch or storage still counts", async () => {
  const h = harness({ stored: [] });
  assert.equal(await persist(langGraphTrace().slice(0, 1), h), 1);
  assert.equal(h.spanRows[0].spanClass, "llm_call");
  assert.equal(h.spanRows[0].inputTokens, 300);
  assert.equal(await persist(agentOnlyTrace(), harness({ stored: [] })), 1);
});

test("a failed lookup drops the root rather than risk double counting", async () => {
  const boom = new Error("db down");
  const h = harness({
    findTracesWithModelCalls: async () => {
      throw boom;
    },
  });
  assert.equal(await persist(langGraphTrace().slice(0, 1), h), 0);
  assert.equal(h.spanRows[0].inputTokens, null);
  assert.deepEqual(h.errors, ["agent span model call lookup failed"]);
  assert.deepEqual(h.failures, [boom]);
});

test("an agent span with no usage or model needs no lookup", async () => {
  const h = harness({});
  const [root] = langGraphTrace();
  const imported = { ...root, attributes: { "gen_ai.operation.name": "invoke_agent" } };
  assert.equal(await persist([imported], h), 0);
  assert.deepEqual(h.lookups, []);
});
