import assert from "node:assert/strict";
import { test } from "node:test";
import type { IngestOutcome, TraceMeteringPort } from "@/lib/contracts/trace-metering";
import type { EventWithMetric } from "@/lib/ingest/otlp/queries";
import type { ApiKey } from "@/lib/platform/projects/schema";
import { handleTracesRequest, type TracesHandlerDeps } from "./route-handler";

/** The trace metering port at ingest: what each outcome stores, and when the port is asked. */

const ANALYZED = "a".repeat(32);
const INGESTED = "b".repeat(32);
const DROPPED = "c".repeat(32);

const KEY = {
  id: "key-1",
  projectId: "proj-1",
  lastUsedAt: new Date(),
  scopes: ["*"],
  revokedAt: null,
  expiresAt: null,
} as ApiKey;

/** One model call and one tool call per trace. */
function body(traceIds: readonly string[]): string {
  const attr = (key: string, stringValue: string) => ({ key, value: { stringValue } });
  const time = {
    startTimeUnixNano: "1751800000000000000",
    endTimeUnixNano: "1751800000200000000",
  };
  const spans = traceIds.flatMap((traceId, i) => [
    {
      ...time,
      traceId,
      spanId: `1${i}`.padEnd(16, "0"),
      name: "chat gpt-5.5",
      kind: 3,
      attributes: [
        attr("gen_ai.operation.name", "chat"),
        attr("gen_ai.request.model", "gpt-5.5"),
        { key: "gen_ai.usage.input_tokens", value: { intValue: "10" } },
      ],
    },
    {
      ...time,
      traceId,
      spanId: `2${i}`.padEnd(16, "0"),
      parentSpanId: `1${i}`.padEnd(16, "0"),
      name: "ratel.search",
      kind: 1,
      attributes: [attr("ratel.search.query", `query ${traceId[0]}`)],
    },
    {
      ...time,
      traceId,
      spanId: `3${i}`.padEnd(16, "0"),
      parentSpanId: `1${i}`.padEnd(16, "0"),
      name: "execute_tool lookup",
      kind: 1,
      attributes: [
        attr("gen_ai.operation.name", "execute_tool"),
        attr("gen_ai.tool.name", "lookup"),
      ],
    },
  ]);
  return JSON.stringify({ resourceSpans: [{ scopeSpans: [{ scope: { name: "x" }, spans }] }] });
}

function setup(
  over: Partial<TracesHandlerDeps> & {
    outcomes?: Record<string, IngestOutcome>;
    on?: boolean;
  } = {},
) {
  const { outcomes = {}, on = true, ...rest } = over;
  const asked: string[][] = [];
  const counted: number[][] = [];
  const errors: string[] = [];
  const stored = { calls: [] as string[], events: [] as string[], spans: [] as string[] };
  const traceMetering: TraceMeteringPort = {
    isMetered: async () => on,
    meterTraceBatch: async (_scope, spansByTrace) => {
      asked.push([...spansByTrace.keys()]);
      counted.push([...spansByTrace.values()]);
      return new Map(Object.entries(outcomes));
    },
  };
  const deps = {
    scope: "ingest:traces",
    isDbConfigured: () => true,
    hashApiKey: (s: string) => s,
    findActiveApiKeyByHash: async () => KEY,
    touchApiKey: async () => {},
    insertEventsWithMetrics: async (_p: string, rows: EventWithMetric[]) => {
      stored.calls.push(...rows.map((r) => r.event.traceId ?? ""));
      return rows.length;
    },
    insertTraceEvents: async (_p: string, rows: { traceId?: string | null }[]) => {
      stored.events.push(...rows.map((r) => r.traceId ?? ""));
      return { accepted: rows.length };
    },
    insertOtelSpans: async (_p: string, rows: { traceId: string }[]) => {
      stored.spans.push(...rows.map((r) => r.traceId));
      return { accepted: rows.length };
    },
    agentSpanDedupe: { findTracesWithModelCalls: async () => new Set() },
    traceTurns: { enqueueBuild: async () => null, scheduleProjectDrain: () => {} },
    agentRunsEnabled: async () => false,
    getOrganizationByProjectId: async () => ({ id: "org-1" }),
    checkEventQuota: async () => ({ ok: true }),
    incrementEventUsage: async () => {},
    traceMetering,
    logError: (message: string) => errors.push(message),
    logWarn: () => {},
    ingestLog: { lookupLabels: async () => null },
    ...rest,
  } as unknown as TracesHandlerDeps;
  const send = (traceIds: readonly string[]) =>
    handleTracesRequest(
      new Request("http://localhost/api/v1/traces", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer rtl_key" },
        body: body(traceIds),
      }),
      deps,
    );
  return { send, asked, counted, errors, stored };
}

const ids = (list: readonly string[]) => [...new Set(list)].sort();
const ALL = [ANALYZED, INGESTED, DROPPED];

test("dropped stores nothing, ingested_only stores no analysis rows, analyzed stores all", async () => {
  const { send, asked, stored } = setup({
    outcomes: { [ANALYZED]: "analyzed", [INGESTED]: "ingested_only", [DROPPED]: "dropped" },
  });
  assert.equal((await send(ALL)).status, 202);
  assert.deepEqual(asked, [ALL], "each trace once");
  assert.deepEqual(ids(stored.calls), [ANALYZED, INGESTED]);
  assert.deepEqual(ids(stored.spans), [ANALYZED, INGESTED]);
  assert.deepEqual(ids(stored.events), [ANALYZED]);
});

test("a batch of dropped traces only still succeeds", async () => {
  const { send, stored } = setup({ outcomes: { [DROPPED]: "dropped" } });
  assert.equal((await send([DROPPED])).status, 202);
  assert.deepEqual(stored, { calls: [], events: [], spans: [] });
});

test("a trace missing from the answer is analyzed", async () => {
  const { send, stored } = setup();
  await send(ALL);
  assert.deepEqual(ids(stored.events), ALL);
});

test("not metered: the batch is never asked for and everything is analyzed", async () => {
  const { send, asked, stored } = setup({ on: false, outcomes: { [DROPPED]: "dropped" } });
  await send(ALL);
  assert.deepEqual(asked, []);
  assert.deepEqual(ids(stored.events), ALL);
  assert.deepEqual(ids(stored.spans), ALL);
});

test("a failed meter never fails the batch: it is analyzed", async () => {
  const { send, errors, stored } = setup({
    traceMetering: {
      isMetered: async () => true,
      meterTraceBatch: async () => {
        throw new Error("meter down");
      },
    },
  });
  assert.equal((await send(ALL)).status, 202);
  assert.deepEqual(errors, ["trace meter write failed"]);
  assert.deepEqual(ids(stored.events), ALL);
});

test("the event cap rejects only an organization that is not metered", async () => {
  const over = {
    checkEventQuota: async () =>
      ({ ok: false, plan: "free", limit: 1, used: 1, message: "over" }) as const,
  };
  assert.equal((await setup({ ...over, on: false }).send(ALL)).status, 429);
  assert.equal((await setup({ ...over, on: true }).send(ALL)).status, 202);
});

test("a span without a trace id cannot be counted, so a metered organization stores none", async () => {
  const metered = setup();
  assert.equal((await metered.send([""])).status, 202);
  assert.deepEqual(metered.stored, { calls: [], events: [], spans: [] });
  const mixed = setup();
  await mixed.send(["", ANALYZED]);
  assert.deepEqual(ids(mixed.stored.calls), [ANALYZED]);
  const unmetered = setup({ on: false });
  await unmetered.send([""]);
  assert.equal(unmetered.stored.calls.length, 1);
});

test("a refused trace stores nothing: 429 when the whole export is refused, else the rest is stored", async () => {
  const refused = setup({ outcomes: { [DROPPED]: "refused" } });
  assert.equal((await refused.send([DROPPED])).status, 429);
  assert.deepEqual(refused.stored, { calls: [], events: [], spans: [] });
  assert.equal((await refused.send([DROPPED, DROPPED])).status, 429);
  // The port counts spans, so one trace id cannot hide how many it brings.
  assert.deepEqual(refused.counted, [[3], [6]]);

  const mixed = setup({ outcomes: { [DROPPED]: "refused" } });
  const response = await mixed.send([ANALYZED, DROPPED]);
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("x-ratel-refused"), "3");
  assert.deepEqual(ids(mixed.stored.spans), [ANALYZED]);
  assert.deepEqual(ids(mixed.stored.calls), [ANALYZED]);
});

test("a span with an oversized trace id is not stored when metered: it cannot break the meter", async () => {
  const huge = "ab".repeat(1_400);
  const { send, asked, stored } = setup();
  await send([huge, ANALYZED]);
  assert.deepEqual(asked, [[ANALYZED]]);
  assert.deepEqual(ids(stored.spans), [ANALYZED]);
});

test("a storage failure gives the metered spans back, so the retry is not refused", async () => {
  const released: [string, number][] = [];
  const { send } = setup({
    insertEventsWithMetrics: async () => {
      throw new Error("database down");
    },
    traceMetering: {
      isMetered: async () => true,
      meterTraceBatch: async () =>
        new Map([
          [ANALYZED, "analyzed"],
          [INGESTED, "refused"],
          [DROPPED, "dropped"],
        ]),
      releaseSpans: async (_scope, spansByTrace) => {
        released.push(...spansByTrace);
      },
    },
  });
  assert.equal((await send(ALL)).status, 500);
  assert.deepEqual(released, [[ANALYZED, 3]]);
});

test("the raw body of a partly refused export is not kept", async () => {
  const captured: string[] = [];
  const otlpRawCapture = {
    store: {
      store: async () => {
        captured.push("raw");
        return { stored: true };
      },
    },
  };
  const kept = setup({ otlpRawCapture } as never);
  await kept.send([ANALYZED]);
  const refused = setup({ otlpRawCapture, outcomes: { [DROPPED]: "refused" } } as never);
  await refused.send([ANALYZED, DROPPED]);
  assert.equal(captured.length, 1);
});

/** A meter that counts as the Cloud's does, and a storage that dedupes span and call ids. */
function metered(limit: number) {
  const counts = new Map<string, number>();
  const storedSpans = new Set<string>();
  const storedCalls = new Set<string>();
  const add = (id: string, n: number) => counts.set(id, (counts.get(id) ?? 0) + n);
  const deps: Partial<TracesHandlerDeps> = {
    traceMetering: {
      isMetered: async () => true,
      meterTraceBatch: async (_scope, spans) =>
        new Map(
          [...spans].map(([id, n]) => {
            if ((counts.get(id) ?? 0) + n > limit) return [id, "refused" as const];
            add(id, n);
            return [id, "analyzed" as const];
          }),
        ),
      releaseSpans: async (_scope, spans) => {
        for (const [id, n] of spans) add(id, -n);
      },
    },
    insertEventsWithMetrics: async (_p, rows) => {
      const fresh = rows.filter((row) => !storedCalls.has(row.event.dedupeHash ?? ""));
      for (const row of fresh) storedCalls.add(row.event.dedupeHash ?? "");
      return fresh.length;
    },
    insertTraceEvents: async () => ({ accepted: 0 }),
    insertOtelSpans: async (_p, rows) => {
      const acceptedByTrace = new Map<string, number>();
      for (const { id, traceId } of rows) {
        if (storedSpans.has(id)) continue;
        storedSpans.add(id);
        acceptedByTrace.set(traceId, (acceptedByTrace.get(traceId) ?? 0) + 1);
      }
      return { accepted: storedSpans.size, acceptedByTrace };
    },
    findStoredOtelSpans: async (_p, spans) =>
      new Set(spans.map(({ id }) => id).filter((id) => storedSpans.has(id))),
  };
  return { send: setup(deps).send, counts };
}

test("a resend of a stored export counts once, also when it filled the bound", async () => {
  const { send, counts } = metered(3);
  for (const _attempt of [1, 2, 3, 4]) assert.equal((await send([ANALYZED])).status, 202);
  assert.equal(counts.get(ANALYZED), 3);
  // The same trace id with new span ids still stops at the bound.
  assert.equal((await send([DROPPED, ANALYZED])).headers.get("x-ratel-refused"), "3");
  assert.equal(counts.get(ANALYZED), 3);
});

test("old span ids that bring new calls are counted", async () => {
  const { send, counts } = metered(100);
  await send([ANALYZED]);
  let calls = 0;
  const again: Partial<TracesHandlerDeps> = {
    traceMetering: {
      isMetered: async () => true,
      meterTraceBatch: async () => new Map([[ANALYZED, "analyzed"]]),
      releaseSpans: async (_scope, spans) => {
        for (const n of spans.values()) calls += n;
      },
    },
    insertEventsWithMetrics: async () => 3,
    insertOtelSpans: async () => ({ accepted: 0, acceptedByTrace: new Map() }),
  };
  await setup(again).send([ANALYZED]);
  assert.equal(calls, 0);
  assert.equal(counts.get(ANALYZED), 3);
});
