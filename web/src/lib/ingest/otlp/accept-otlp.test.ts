import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { createPublishableIngestLimits } from "@/lib/ingest/ingest-limits";
import { PUBLISH_TIMEOUT_MS } from "@/lib/ingest/queue/accept";
import { decodeEnvelope, type Envelope, encodeEnvelope } from "@/lib/ingest/queue/envelope";
import { createQuotaGate } from "@/lib/ingest/queue/quota-gate";
import { loadFixture } from "@/lib/ledger/turns/real-fixtures";
import { chunkedCountingBody } from "@/lib/platform/http/test-support";
import type { ApiKey } from "@/lib/platform/projects/schema";
import { MAX_BODY_BYTES } from "./body";
import { countOtlpItems } from "./count-items";
import { decodeOtlp } from "./decode";
import { handleTracesRequest, type TracesHandlerDeps } from "./route-handler";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const KEY: ApiKey = {
  id: "33333333-3333-4333-8333-333333333333",
  projectId: PROJECT_ID,
  name: "test",
  keyHash: "hash",
  keyPrefix: "rtl_abc",
  createdAt: new Date(),
  lastUsedAt: null,
  revokedAt: null,
  expiresAt: null,
  scopes: ["*"],
  rateLimitPerMinute: null,
};
const SHARED: ApiKey = { ...KEY, scopes: ["ingest:traces"] };
const NOW = new Date("2026-11-20T10:00:00.000Z");
const never = async (): Promise<never> => assert.fail("accept stores nothing");

function setup(over: Partial<TracesHandlerDeps> & { key?: ApiKey } = {}) {
  const published: Envelope[] = [];
  const rejections: string[] = [];
  const { key = KEY, ...rest } = over;
  const deps: TracesHandlerDeps = {
    scope: "ingest:traces",
    isDbConfigured: () => true,
    hashApiKey: (plaintext) => plaintext,
    findActiveApiKeyByHash: async () => key,
    touchApiKey: never,
    insertEventsWithMetrics: never,
    insertTraceEvents: never,
    insertOtelSpans: never,
    agentSpanDedupe: { findTracesWithModelCalls: never },
    logWarn: (_message, fields) => {
      rejections.push(`${fields?.status} ${fields?.reason}`);
    },
    shouldSampleRejection: () => false,
    now: () => NOW,
    quotaGate: createQuotaGate(),
    accept: {
      queue: {
        publish: async (envelope) => {
          published.push(decodeEnvelope(encodeEnvelope(envelope)));
        },
      },
      findOrganizationId: async () => ORGANIZATION_ID,
    },
    ...rest,
  };
  const send = (body: BodyInit | null, headers: Record<string, string> = {}) =>
    handleTracesRequest(
      new Request("http://localhost/api/v1/traces", {
        method: "POST",
        headers: { Authorization: "Bearer k", "Content-Type": "application/json", ...headers },
        body,
        // @ts-expect-error Node needs it for a stream body; the DOM type does not know it.
        duplex: "half",
      }),
      deps,
    );
  return { published, rejections, send, deps };
}

const spansBody = (count: number) =>
  JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: Array(count).fill({}) }] }] });

test("one request is one envelope, with the body as received", async () => {
  const { send, published } = setup();
  const bytes = new Uint8Array(gzipSync('{"resourceSpans":[]}'));
  const response = await send(bytes, { "Content-Encoding": "x-gzip" });
  assert.equal(response.status, 202);
  const [{ id, body, ...rest }] = published;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(body, bytes);
  assert.deepEqual(rest, {
    version: 1,
    projectId: PROJECT_ID,
    organizationId: ORGANIZATION_ID,
    keyId: KEY.id,
    keyPolicy: { appendOnlyIngest: false, sharedKeyLimits: false },
    signal: "traces",
    contentType: "application/json",
    contentEncoding: "gzip",
    receivedAt: NOW.getTime(),
  });
});

test("a secret key's body is not read beyond its bytes", async () => {
  const { send, published } = setup();
  for (const body of ["not json", spansBody(5_001), ""]) {
    assert.equal((await send(body)).status, 202);
  }
  assert.equal(published.length, 3);
});

test("the refusals of headers, key and size stay as they are", async () => {
  const { send, published, rejections, deps } = setup();
  const status = async (body: BodyInit | null, headers: Record<string, string>) =>
    (await send(body, headers)).status;
  assert.equal(await status("{}", { Authorization: "nope" }), 401);
  assert.equal(await status("{}", { "Content-Type": "text/plain" }), 415);
  assert.equal(await status("{}", { "Content-Encoding": "br" }), 415);
  assert.equal(await status(Buffer.alloc(MAX_BODY_BYTES + 1), {}), 413);
  const { stream } = chunkedCountingBody({
    chunkBytes: 500_000,
    totalBytes: MAX_BODY_BYTES + 500_000,
  });
  assert.equal(await status(stream, {}), 413);
  deps.isDbConfigured = () => false;
  assert.equal(await status("{}", {}), 503);
  deps.isDbConfigured = () => true;
  deps.findActiveApiKeyByHash = async () => null;
  assert.equal(await status("{}", {}), 401);
  deps.findActiveApiKeyByHash = async () => ({ ...KEY, scopes: ["catalog:read"] });
  assert.equal(await status("{}", {}), 403);
  assert.equal(published.length, 0);
  assert.deepEqual(rejections, [
    "401 invalid_key",
    "415 unsupported_media",
    "415 malformed",
    "413 oversized",
    "413 oversized",
    "503 unavailable",
    "401 invalid_key",
    "403 missing_scope",
  ]);
});

test("a publish that fails or does not confirm in time is a 503 with Retry-After", async () => {
  assert.equal(PUBLISH_TIMEOUT_MS, 10_000);
  const publishes = [
    async () => Promise.reject(new Error("queue down")),
    () => new Promise<void>(() => {}),
  ];
  for (const publish of publishes) {
    const { send, rejections } = setup({
      accept: {
        queue: { publish },
        findOrganizationId: async () => ORGANIZATION_ID,
        publishTimeoutMs: 20,
      },
    });
    const response = await send("{}");
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "5");
    assert.deepEqual(await response.json(), {
      error: "Ingestion is not available. Try again.",
    });
    assert.deepEqual(rejections, ["503 unavailable"]);
  }
});

test("the monthly cap is asked once a minute, and never for a metered organization", async () => {
  let now = 0;
  let asked = 0;
  let over = true;
  const quota = {
    getOrganizationByProjectId: async () => ({ id: ORGANIZATION_ID }) as never,
    checkEventQuota: async () => {
      asked += 1;
      return over
        ? { ok: false as const, message: "Over the limit.", used: 1, limit: 1 }
        : { ok: true as const };
    },
    quotaGate: createQuotaGate(() => now),
  } as Partial<TracesHandlerDeps>;
  const { send, published } = setup(quota);
  const refused = await send("{}");
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), { error: "Over the limit." });
  over = false;
  assert.equal((await send("{}")).status, 429, "cached");
  now = 60_000;
  assert.equal((await send("{}")).status, 202);
  assert.equal(asked, 2);
  assert.equal(published.length, 1);

  over = true;
  const metered = setup({
    ...quota,
    quotaGate: createQuotaGate(),
    traceMetering: { isMetered: async () => true, meterTraceBatch: never },
  });
  assert.equal((await metered.send("{}")).status, 202);
});

test("a failed quota read is not kept", async () => {
  const gate = createQuotaGate(() => 0);
  await assert.rejects(gate.check("o", async () => Promise.reject(new Error("down"))));
  assert.deepEqual(await gate.check("o", async () => ({ ok: true })), { ok: true });
});

test("a shared key's items are counted before the message is durable", async () => {
  const publishableLimits = createPublishableIngestLimits({
    perKeyPerMinute: 100,
    perSourcePerMinute: 100,
    perKeyItemsPerMinute: 100,
    perSourceItemsPerMinute: 100,
  });
  const { send, published } = setup({ key: SHARED, publishableLimits });
  const malformed = await send("not json");
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /^Malformed OTLP payload: /);
  assert.equal((await send("[")).status, 400);
  assert.equal((await send('{"resourceSpans":{}}')).status, 400);
  assert.equal((await send("not gzip", { "Content-Encoding": "gzip" })).status, 400);
  const zipBomb = new Uint8Array(gzipSync(Buffer.alloc(16_000_001, " ")));
  const bomb = await send(zipBomb, { "Content-Encoding": "gzip" });
  assert.equal(bomb.status, 413);
  const tooMany = await send(spansBody(5_001));
  assert.equal(tooMany.status, 413);
  assert.deepEqual(await tooMany.json(), {
    error: "Too many spans in one export (max 5000).",
  });
  assert.equal((await send(spansBody(150))).status, 202);
  const limited = await send(spansBody(150));
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get("retry-after"));
  assert.deepEqual(
    published.map(({ keyPolicy }) => keyPolicy),
    [{ appendOnlyIngest: true, sharedKeyLimits: true }],
  );
});

test("the walk counts what the decoder decodes", () => {
  const real = join(import.meta.dirname, "__fixtures__/real");
  const names = readdirSync(real, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  let spans = 0;
  for (const { name } of names) {
    for (const { contentType, bytes } of loadFixture(name)) {
      const transport = contentType.includes("json") ? "json" : "protobuf";
      const decoded = decodeOtlp(contentType, bytes).length;
      assert.equal(countOtlpItems("traces", transport, bytes), decoded, name);
      spans += decoded;
    }
  }
  assert.ok(spans > 100);
  const truncated = Uint8Array.from([0x0a, 0xff, 0x01]);
  assert.throws(() => countOtlpItems("traces", "protobuf", truncated), /protobuf walk failed/);
  assert.equal(countOtlpItems("logs", "json", Buffer.from("{}")), 0);
});
