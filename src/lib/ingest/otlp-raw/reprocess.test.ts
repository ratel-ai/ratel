import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { LANGGRAPH_TRACE, langGraphTrace } from "@/lib/ingest/otlp/agent-span-fixtures";
import { decodeOtlp } from "@/lib/ingest/otlp/decode";
import { groupSpans } from "@/lib/ingest/otlp/group";
import { normalizeAiSdkSpans } from "@/lib/ingest/otlp/normalize-ai-sdk";
import type { EventWithMetric } from "@/lib/ingest/otlp/queries";
import { toRows } from "@/lib/ingest/otlp/reconstruct";
import {
  planReprocess,
  type ReprocessDeps,
  type ReprocessIngestFlags,
  type ReprocessPlan,
  rebuildEventRows,
  reprocessOtlpRawExports,
  type StoredEvent,
} from "./reprocess";
import type { OtlpRawExportBody } from "./store";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SINCE = new Date("2026-11-01T00:00:00.000Z");
const FLAGS: ReprocessIngestFlags = {
  captureReply: false,
  agentSpanDedupe: { findTracesWithModelCalls: async () => new Set() },
};

test("a dry run reports the cache tokens a new alias reads, and writes nothing", async () => {
  const store = storeIngestedBeforeAliases([chatExport("a1")]);

  const { report, applied } = await run(store, { apply: false });

  assert.equal(applied.length, 0);
  assert.equal(report.exports, 1);
  assert.equal(report.rebuiltEvents, 1);
  assert.equal(report.changedEvents, 1);
  assert.equal(report.newEvents, 0);
  assert.equal(report.before.cachedTokens, 0);
  assert.equal(report.after.cachedTokens, 800);
  assert.equal(report.before.inputTokens, 1000);
  assert.equal(report.after.inputTokens, 1000);
  assert.ok(report.after.costUsd < report.before.costUsd, "cached input is billed at the discount");
});

test("--apply patches usage, cost and metrics, and a second --apply changes nothing", async () => {
  const store = storeIngestedBeforeAliases([chatExport("a1")]);

  const first = await run(store, { apply: true });
  assert.equal(first.report.changedEvents, 1);
  assert.equal(first.applied.length, 1);
  const [patched] = [...store.events.values()];
  assert.equal(patched.event.cachedTokens, 800);
  assert.ok(patched.metric);
  assert.ok(Number(patched.metric.costUsd) < Number(first.report.before.costUsd));

  const second = await run(store, { apply: true });
  assert.equal(second.applied.length, 0);
  assert.equal(second.report.changedEvents, 0);
  assert.equal(second.report.newEvents, 0);
  assert.equal(second.report.unchangedEvents, 1);
});

test("a call ingest did not store is inserted once", async () => {
  const store = storeIngestedBeforeAliases([]);
  store.exports.push(rawExport(chatExport("b1")));

  const first = await run(store, { apply: true });
  assert.equal(first.report.newEvents, 1);
  assert.equal(first.report.inserted.cachedTokens, 800);
  assert.equal(store.events.size, 1);

  const second = await run(store, { apply: true });
  assert.equal(second.applied.length, 0);
  assert.equal(second.report.unchangedEvents, 1);
});

test("a stored row matches by span id when the rebuilt dedupe hash differs", async () => {
  const [row] = rowsBeforeAliases(chatExport("c1"));
  const stored = storedFrom("event-1", {
    ...row,
    event: { ...row.event, dedupeHash: "hash-from-an-older-mapping" },
  });

  const plan = planReprocess(await rowsFor(chatExport("c1")), [stored]);

  assert.equal(plan.inserts.length, 0);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].eventId, "event-1");
});

test("jsonb key order and numeric(12,6) cost rounding are not a change", async () => {
  const [row] = await rowsFor(chatExport("d1"));
  const stored = storedFrom("event-1", row);
  stored.event.payload = reversedKeys(stored.event.payload);
  stored.event.costUsd = Number(row.event.costUsd).toFixed(6);

  const plan = planReprocess([row], [stored]);

  assert.equal(plan.unchanged, 1);
  assert.equal(plan.updates.length, 0);
});

test("a stored event with no metrics row gets one", async () => {
  const [row] = await rowsFor(chatExport("e1"));
  const stored = { ...storedFrom("event-1", row), metric: null };

  const plan = planReprocess([row], [stored]);

  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].metric.toolsTotalCount, row.metric.toolsTotalCount);
});

test("log exports are skipped and undecodable bodies are counted", async () => {
  const store = storeIngestedBeforeAliases([]);
  store.exports.push(
    { ...rawExport({ resourceLogs: [] }), signal: "logs" },
    { ...rawExport({}), body: new Uint8Array(gzipSync(Buffer.from("not json"))) },
  );

  const { report } = await run(store, { apply: true });

  assert.equal(report.exports, 2);
  assert.equal(report.skippedLogExports, 1);
  assert.equal(report.undecodableExports, 1);
  assert.equal(report.rebuiltEvents, 0);
});

test("exports are read and applied in bounded batches", async () => {
  const store = storeIngestedBeforeAliases([chatExport("f1"), chatExport("f2"), chatExport("f3")]);

  const { applied, pages } = await run(store, { apply: true, pageSize: 2 });

  assert.deepEqual(pages, [2, 1]);
  assert.deepEqual(
    applied.map((plan) => plan.updates.length),
    [2, 1],
  );
});

/** An in-memory `otlp_raw_exports` + `events` + `event_metrics`, stored the way Postgres would. */
interface FakeStore {
  exports: OtlpRawExportBody[];
  events: Map<string, StoredEvent>;
}

/** A store whose rows ingest wrote before it read the semconv aliases (RC-380). */
function storeIngestedBeforeAliases(bodies: object[]): FakeStore {
  const store: FakeStore = { exports: [], events: new Map() };
  for (const body of bodies) {
    store.exports.push(rawExport(body));
    for (const row of rowsBeforeAliases(body)) {
      const id = `event-${store.events.size + 1}`;
      store.events.set(id, storedFrom(id, row));
    }
  }
  return store;
}

async function run(store: FakeStore, options: { apply: boolean; pageSize?: number }) {
  const applied: ReprocessPlan[] = [];
  const pages: number[] = [];
  const deps: ReprocessDeps = {
    flags: FLAGS,
    async readPage(after, limit) {
      const start = after ? store.exports.indexOf(after) + 1 : 0;
      const page = store.exports.slice(start, start + limit);
      pages.push(page.length);
      return page;
    },
    async findStoredEvents({ dedupeHashes, traceIds }) {
      return [...store.events.values()]
        .filter(
          (e) =>
            (e.dedupeHash && dedupeHashes.includes(e.dedupeHash)) ||
            (e.traceId && traceIds.includes(e.traceId)),
        )
        .map((e) => structuredClone(e));
    },
    async applyPlan(plan) {
      applied.push(plan);
      for (const update of plan.updates) {
        const current = store.events.get(update.eventId)!;
        store.events.set(
          update.eventId,
          storedFrom(update.eventId, {
            event: {
              ...current.event,
              ...update.event,
              dedupeHash: current.dedupeHash,
              traceId: current.traceId,
              spanId: current.spanId,
              projectId: PROJECT_ID,
            },
            metric: update.metric,
          }),
        );
      }
      for (const row of plan.inserts) {
        const id = `event-${store.events.size + 1}`;
        store.events.set(id, storedFrom(id, row));
      }
    },
  };
  const report = await reprocessOtlpRawExports(
    { projectId: PROJECT_ID, since: SINCE, apply: options.apply, pageSize: options.pageSize },
    deps,
  );
  return { report, applied, pages };
}

async function rowsFor(body: object): Promise<EventWithMetric[]> {
  return rebuildEventRows(PROJECT_ID, decode(body), FLAGS);
}

/** The rows ingest derived before the semconv alias pass. */
function rowsBeforeAliases(body: object): EventWithMetric[] {
  const spans = decode(body);
  normalizeAiSdkSpans(spans);
  return toRows(PROJECT_ID, groupSpans(spans), { captureReply: false });
}

function decode(body: object) {
  return decodeOtlp("application/json", new TextEncoder().encode(JSON.stringify(body)));
}

/** A row as Postgres returns it: jsonb round-tripped, cost as numeric(12,6). */
function storedFrom(id: string, row: EventWithMetric): StoredEvent {
  const { event, metric } = JSON.parse(JSON.stringify(row)) as EventWithMetric;
  const cost = (value: string | null | undefined) =>
    value == null ? null : Number(value).toFixed(6);
  return {
    id,
    dedupeHash: event.dedupeHash ?? null,
    traceId: event.traceId ?? null,
    spanId: event.spanId ?? null,
    event: {
      provider: event.provider ?? null,
      model: event.model ?? null,
      stream: event.stream ?? null,
      finishReason: event.finishReason ?? null,
      latencyMs: event.latencyMs ?? null,
      inputTokens: event.inputTokens ?? null,
      outputTokens: event.outputTokens ?? null,
      cachedTokens: event.cachedTokens ?? null,
      reasoningTokens: event.reasoningTokens ?? null,
      costUsd: cost(event.costUsd),
      payload: event.payload ?? null,
      categorizerVersion: event.categorizerVersion ?? null,
    },
    metric: {
      tokensByCategory: metric.tokensByCategory,
      splits: metric.splits,
      toolsByName: metric.toolsByName ?? {},
      toolsTotalCount: metric.toolsTotalCount ?? 0,
      toolsUsedCount: metric.toolsUsedCount ?? 0,
      inputTokens: metric.inputTokens ?? null,
      outputTokens: metric.outputTokens ?? null,
      costUsd: cost(metric.costUsd),
      latencyMs: metric.latencyMs ?? null,
      categorizerVersion: metric.categorizerVersion,
    },
  };
}

function rawExport(body: object): OtlpRawExportBody {
  return {
    id: crypto.randomUUID(),
    receivedAt: SINCE,
    signal: "traces",
    contentType: "application/json",
    body: new Uint8Array(gzipSync(Buffer.from(JSON.stringify(body)))),
  };
}

/** One Anthropic chat span that sends its cache reads under the OpenLLMetry key only. */
function chatExport(spanId: string): object {
  const startMs = Date.parse("2026-11-05T10:00:00.000Z");
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "agent" } }] },
        scopeSpans: [
          {
            scope: { name: "opentelemetry.instrumentation.anthropic" },
            spans: [
              {
                traceId: "0af7651916cd43dd8448eb211c80319c",
                spanId: spanId.padStart(16, "0"),
                name: "chat claude-sonnet-4-5",
                kind: 3,
                startTimeUnixNano: `${startMs}000000`,
                endTimeUnixNano: `${startMs + 1200}000000`,
                attributes: [
                  { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
                  { key: "gen_ai.provider.name", value: { stringValue: "anthropic" } },
                  { key: "gen_ai.request.model", value: { stringValue: "claude-sonnet-4-5" } },
                  { key: "gen_ai.usage.input_tokens", value: { intValue: "1000" } },
                  { key: "gen_ai.usage.output_tokens", value: { intValue: "50" } },
                  { key: "gen_ai.usage.cache_read_input_tokens", value: { intValue: "800" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function reversedKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reversedKeys) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([k, v]) => [k, reversedKeys(v)]),
    ) as T;
  }
  return value;
}

test("the rebuilt cost uses the project's price book (RC-482)", async () => {
  const book = { overrides: { "claude-sonnet-4-5": { input: 1000, output: 1000 } } };

  const [builtIn] = await rowsFor(chatExport("p1"));
  const [priced] = await rebuildEventRows(PROJECT_ID, decode(chatExport("p1")), {
    ...FLAGS,
    prices: book,
  });

  assert.notEqual(builtIn.event.costUsd, priced.event.costUsd);
  assert.equal(Number(priced.event.costUsd), 1.05);
  assert.equal(Number(priced.metric.costUsd), 1.05);
});

test("a stored row of another trace with the same span id is not matched", async () => {
  const [row] = await rowsFor(chatExport("g1"));
  const other = storedFrom("event-other", {
    ...row,
    event: {
      ...row.event,
      dedupeHash: "hash-of-another-call",
      traceId: "ffffffffffffffffffffffffffffffff",
    },
  });

  const plan = planReprocess([row], [other]);

  assert.equal(plan.updates.length, 0);
  assert.equal(plan.inserts.length, 1);
});

test("a rebuild always dedupes: the agent wrapper over its model calls is no row", async () => {
  const rows = await rebuildEventRows(PROJECT_ID, langGraphTrace(), FLAGS);
  assert.deepEqual(
    rows.map((r) => r.event.spanId),
    ["1000000000000002", "1000000000000003"],
  );
});

test("a rebuild asks storage for a wrapper exported after its model calls", async () => {
  const asked: string[][] = [];
  const flags: ReprocessIngestFlags = {
    ...FLAGS,
    agentSpanDedupe: {
      findTracesWithModelCalls: async (_projectId, traceIds) => {
        asked.push(traceIds);
        return new Set(traceIds);
      },
    },
  };
  assert.deepEqual(await rebuildEventRows(PROJECT_ID, langGraphTrace().slice(0, 1), flags), []);
  assert.deepEqual(asked, [[LANGGRAPH_TRACE]]);
});

test("a rebuild has no dedupe-off mode", () => {
  // @ts-expect-error `agentSpanDedupe` is required: absent no longer means off.
  const flags: ReprocessIngestFlags = { captureReply: false };
  assert.ok(flags);
});
