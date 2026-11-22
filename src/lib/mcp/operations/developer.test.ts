import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeEventRejectRow, RuntimeEventRow } from "@/lib/ingest/runtime-events/queries";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import {
  type DeveloperOperationDeps,
  developerOperations,
  SDK_EVENT_PAYLOAD_CHARS,
} from "@/lib/mcp/operations/developer";
import { buildRegistry } from "@/lib/mcp/registry";
import type { ApiKeyRecord } from "@/lib/platform/api-key-actions";

/**
 * Settings › Developer, Settings › API keys and Models › Tool Picker over MCP.
 * The property that matters most is negative: list_api_keys must never carry
 * a hash or the key itself, even though the stored row holds both.
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-05T12:00:00.000Z");
const quiet = { warn: () => {}, error: () => {}, info: () => {} } as never;

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

function eventRow(patch: Partial<RuntimeEventRow> = {}): RuntimeEventRow {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    eventId: "evt-1",
    type: "invoke_error",
    sourceId: "source-a",
    sourceStatus: "active",
    sourceLastSeenAt: NOW,
    occurredAt: new Date("2026-11-05T11:00:00.000Z"),
    receivedAt: new Date("2026-11-05T11:00:01.000Z"),
    invocationId: "inv-1",
    traceId: "trace-1",
    spanId: "span-1",
    toolId: "http_post",
    skillId: null,
    query: null,
    origin: null,
    tookMs: 120,
    errorMessage: "upstream returned 500",
    topK: null,
    hitCount: null,
    server: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    payload: { tool_id: "http_post", error: "upstream returned 500" },
    ...patch,
  };
}

function rejectRow(patch: Partial<RuntimeEventRejectRow> = {}): RuntimeEventRejectRow {
  return {
    id: "r-1",
    eventId: "evt-9",
    type: "search",
    reason: "payload_too_large",
    sizeBytes: 300_000,
    sourceId: "source-a",
    receivedAt: new Date("2026-11-05T10:00:00.000Z"),
    ...patch,
  };
}

function unused(name: string) {
  return async () => {
    throw new Error(`${name} should not be called`);
  };
}

function deps(overrides: Partial<DeveloperOperationDeps> = {}): DeveloperOperationDeps {
  return {
    countRuntimeEvents: async () => 42,
    sumRuntimeEventClientDrops: async () => 0,
    countRuntimeEventRejects: async () => 0,
    listRuntimeEvents: async () => [eventRow()],
    listRuntimeEventRejects: unused("listRuntimeEventRejects"),
    summarizeRuntimeEventClientDrops: unused("summarizeRuntimeEventClientDrops"),
    listRuntimeEventFacets: async () => ({
      types: ["invoke_error", "search"],
      sources: [
        { sourceId: "source-a", status: "active", lastSeenAt: NOW },
        {
          sourceId: "source-old",
          status: "dormant",
          lastSeenAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      ],
    }),
    getRuntimeEvent: async () => null,
    listApiKeysForProject: async () => [],
    getProject: async () => ({ id: PROJECT, slug: "support-bot" }),
    publicUrl: (path) => `https://cloud.example.test${path}`,
    projectEntitiesEnabled: async () => false,
    now: () => NOW,
    contentOptIn: async () => true,
    ...overrides,
  } as DeveloperOperationDeps;
}

async function run(
  operationId: string,
  params: Record<string, unknown> = {},
  overrides: Partial<DeveloperOperationDeps> = {},
) {
  const result = await dispatchOperation(operationId, params, {
    registry: buildRegistry(developerOperations(deps(overrides))),
    auth,
    logger: quiet,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as {
    ok: true;
    data: Record<string, unknown>;
    truncated?: boolean;
    window?: { since: string; until: string };
    hint?: string;
  };
}

/* ----------------------------- list_sdk_events ----------------------------- */

test("list_sdk_events: the summary, facets and newest events for the window", async () => {
  const filters: unknown[] = [];
  const result = await run(
    "list_sdk_events",
    { range: "24h", type: "invoke_error" },
    {
      countRuntimeEvents: async (_projectId, windowFilters) => {
        filters.push(windowFilters);
        return 42;
      },
      countRuntimeEventRejects: async () => 2,
    },
  );
  const data = result.data;

  assert.deepEqual(result.window, { since: "2026-11-04T12:00:00.000Z", until: NOW.toISOString() });
  // The summary counts the whole window; the type filter applies to the list only.
  assert.deepEqual(filters, [
    { sourceId: undefined, since: new Date("2026-11-04T12:00:00.000Z"), until: NOW },
  ]);
  assert.deepEqual(data.summary, { received: 42, dropped: 0, rejected: 2, activeSources: 1 });
  assert.match(String(data.verdict), /refused 2 events/);

  const [event] = data.events as Array<Record<string, unknown>>;
  assert.equal(event?.identifier, "evt-1");
  assert.equal(event?.label, "Tool call failed");
  assert.equal(event?.traceId, "trace-1");
  assert.equal(event?.error, "upstream returned 500");
  assert.equal("payload" in (event ?? {}), false, "the list never carries payloads");

  const facets = data.facets as {
    types: Array<{ label: string }>;
    sources: Array<{ note: string | null }>;
  };
  assert.deepEqual(
    facets.types.map((type) => type.label),
    ["Tool call failed", "Tool search"],
  );
  assert.equal(facets.sources[1]?.note, "Quiet for 30 days");
});

test("list_sdk_events over-fetches by one so a full page says there is more", async () => {
  const seen: unknown[] = [];
  const result = await run(
    "list_sdk_events",
    { limit: 2 },
    {
      listRuntimeEvents: async (_projectId, filters) => {
        seen.push(filters.limit);
        return [eventRow({ id: "a" }), eventRow({ id: "b" }), eventRow({ id: "c" })];
      },
    },
  );
  assert.deepEqual(seen, [3]);
  assert.equal((result.data.events as unknown[]).length, 2);
  assert.equal(result.truncated, true);
});

test("view rejects lists what Ratel refused, with reason and size", async () => {
  const { data } = await run(
    "list_sdk_events",
    { view: "rejects" },
    {
      listRuntimeEvents: unused("listRuntimeEvents"),
      listRuntimeEventRejects: async () => [rejectRow()],
    },
  );
  assert.deepEqual(data.rejects, [
    {
      at: "2026-11-05T10:00:00.000Z",
      reason: "payload_too_large",
      eventId: "evt-9",
      label: "Tool search",
      type: "search",
      source: "source-a",
      sizeBytes: 300_000,
    },
  ]);
  assert.equal(data.events, undefined);
});

test("view drops lists what the SDK shed before sending", async () => {
  const { data } = await run(
    "list_sdk_events",
    { view: "drops" },
    {
      listRuntimeEvents: unused("listRuntimeEvents"),
      summarizeRuntimeEventClientDrops: async () => [
        {
          sourceId: "source-a",
          reason: "queue_full",
          droppedCount: 17,
          windowCount: 3,
          lastDropAt: NOW,
        },
      ],
    },
  );
  assert.deepEqual(data.drops, [
    {
      source: "source-a",
      reason: "queue_full",
      dropped: 17,
      reports: 3,
      lastAt: NOW.toISOString(),
    },
  ]);
});

test("a failed count costs that number, not the answer", async () => {
  const { data } = await run(
    "list_sdk_events",
    {},
    {
      countRuntimeEvents: async () => {
        throw Object.assign(new Error("canceling statement due to statement timeout"), {
          code: "57014",
        });
      },
    },
  );
  assert.equal((data.summary as Record<string, unknown>).received, null);
  assert.equal(data.verdict, null);
  assert.equal((data.events as unknown[]).length, 1);
});

test("a timed-out list is reported as a timeout", async () => {
  const result = await dispatchOperation(
    "list_sdk_events",
    {},
    {
      registry: buildRegistry(
        developerOperations(
          deps({
            listRuntimeEvents: async () => {
              throw Object.assign(new Error("timeout"), { code: "57014" });
            },
          }),
        ),
      ),
      auth,
      logger: quiet,
    },
  );
  assert.equal(result.ok === false && result.error, "timeout");
});

/* ------------------------------ get_sdk_event ------------------------------ */

test("get_sdk_event returns the payload, cut at the cap", async () => {
  const big = { blob: "x".repeat(SDK_EVENT_PAYLOAD_CHARS * 2) };
  const result = await run(
    "get_sdk_event",
    { identifier: "evt-1" },
    {
      getRuntimeEvent: async (_projectId, identifier) =>
        identifier === "evt-1" ? eventRow({ payload: big }) : null,
    },
  );
  const payload = String(result.data.payload);

  assert.ok(payload.length <= SDK_EVENT_PAYLOAD_CHARS + 1);
  assert.equal(result.data.payloadChars, JSON.stringify(big).length);
  assert.equal(result.truncated, true);
  assert.equal((result.data.event as Record<string, unknown>).identifier, "evt-1");
});

test("get_sdk_event: a small payload comes whole", async () => {
  const result = await run(
    "get_sdk_event",
    { identifier: "evt-1" },
    { getRuntimeEvent: async () => eventRow() },
  );
  assert.deepEqual(JSON.parse(String(result.data.payload)), {
    tool_id: "http_post",
    error: "upstream returned 500",
  });
  assert.equal(result.truncated, undefined);
});

test("get_sdk_event: an unknown event is not found", async () => {
  const result = await dispatchOperation(
    "get_sdk_event",
    { identifier: "nope" },
    {
      registry: buildRegistry(developerOperations(deps())),
      auth,
      logger: quiet,
    },
  );
  assert.equal(result.ok === false && result.error, "not_found");
});

/* ------------------------------ list_api_keys ------------------------------ */

const PLAINTEXT = "rtl_live_secret_value_that_must_never_leave";
const HASH = "f".repeat(64);

function storedKey(patch: Partial<ApiKeyRecord> = {}) {
  // The stored row as the query returns it: hash and plaintext included.
  return {
    id: "key-1",
    projectId: PROJECT,
    name: "production",
    keyPrefix: "rtl_live_s",
    keyHash: HASH,
    keyPlaintext: PLAINTEXT,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    lastUsedAt: new Date("2026-11-05T11:59:00.000Z"),
    revokedAt: null,
    expiresAt: null,
    scopes: ["*"],
    ...patch,
  } as ApiKeyRecord;
}

test("list_api_keys lists keys as the page does, never the hash or the key", async () => {
  const { data } = await run(
    "list_api_keys",
    {},
    {
      listApiKeysForProject: async () => [
        storedKey(),
        storedKey({ id: "key-2", name: null, expiresAt: new Date("2026-11-01T00:00:00.000Z") }),
      ],
    },
  );
  const keys = data.keys as Array<Record<string, unknown>>;

  assert.deepEqual(keys[0], {
    id: "key-1",
    name: "production",
    keyPrefix: "rtl_live_s",
    access: "full",
    scopes: ["*"],
    publishable: false,
    status: "active",
    createdAt: "2026-10-01T00:00:00.000Z",
    lastUsedAt: "2026-11-05T11:59:00.000Z",
    expiresAt: null,
    usedByThisSession: true,
  });
  assert.equal(keys[1]?.status, "expired");
  const ingest = await run(
    "list_api_keys",
    {},
    {
      listApiKeysForProject: async () => [
        storedKey({ scopes: ["ingest:traces", "ingest:logs", "ingest:events"] }),
      ],
    },
  );
  const ingestKey = (ingest.data.keys as Array<Record<string, unknown>>)[0];
  assert.equal(ingestKey?.access, "ingest");
  assert.equal(ingestKey?.publishable, true);
  assert.equal(keys[1]?.usedByThisSession, false);

  const text = JSON.stringify(data);
  assert.ok(!text.includes(PLAINTEXT), "plaintext must never be returned");
  assert.ok(!text.includes(HASH), "the hash must never be returned");
  for (const key of keys) {
    assert.ok(!("keyHash" in key) && !("keyPlaintext" in key) && !("projectId" in key));
  }
});

/* ------------------------------ get_sdk_setup ------------------------------ */

test("get_sdk_setup hands out the page's snippets with the key read from the environment", async () => {
  const { data } = await run(
    "get_sdk_setup",
    {},
    { listApiKeysForProject: unused("listApiKeysForProject") },
  );
  const snippets = data.snippets as Array<{ lang: string; install: string | null; code: string }>;

  assert.equal(data.endpoint, "https://cloud.example.test/v1/traces");
  assert.equal(data.keyEnvVar, "RATEL_API_KEY");
  assert.deepEqual(
    snippets.map((snippet) => snippet.lang),
    ["typescript", "curl"],
  );
  assert.match(snippets[0]?.code ?? "", /"support-bot"/);
  assert.match(snippets[1]?.code ?? "", /\$RATEL_API_KEY/);
  assert.ok(!/rtl_[A-Za-z0-9]/.test(JSON.stringify(data)), "no key is ever inlined");
  assert.equal(data.contentCapture, undefined);
  assert.equal(data.mcpServer, undefined, "no MCP server guide with FF_AGENTS_PAGES off");
});

test("get_sdk_setup adds the MCP server guide with FF_AGENTS_PAGES on (RC-780)", async () => {
  const { data } = await run("get_sdk_setup", {}, { projectEntitiesEnabled: async () => true });
  const guide = data.mcpServer as {
    env: string;
    snippets: Array<{ lang: string }>;
    limits: string[];
  };
  assert.match(
    guide.env,
    /OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https:\/\/cloud\.example\.test\/v1\/traces/,
  );
  assert.deepEqual(
    guide.snippets.map((snippet) => snippet.lang),
    ["python", "typescript"],
  );
  assert.ok(guide.limits.length > 0);
  assert.ok(!/rtl_[A-Za-z0-9]/.test(JSON.stringify(data)), "no key is ever inlined");
});

test("get_sdk_setup with captureContent adds the capture lines", async () => {
  const { data } = await run("get_sdk_setup", { captureContent: true });
  const snippets = data.snippets as Array<{ code: string }>;
  assert.match(snippets[0]?.code ?? "", /OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT/);
  assert.deepEqual(data.contentCapture, {
    envVar: "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT",
    value: "SPAN_AND_EVENT",
  });
});

/* ---------------------------- captured text ---------------------------- */

const OAUTH: McpAuthContext = {
  kind: "oauth",
  externalUserId: "user_abc",
  userId: "u-1",
  memberships: [
    {
      organizationId: "org-1",
      role: "member",
      organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
    },
  ],
};

const CONTENT_CASES = [
  { name: "an API key with the content opt-in off", caller: auth, optIn: false, sees: false },
  { name: "an API key with the content opt-in on", caller: auth, optIn: true, sees: true },
  { name: "a signed-in member, whatever the opt-in", caller: OAUTH, optIn: false, sees: true },
] as const;

for (const { name, caller, optIn, sees } of CONTENT_CASES) {
  test(`developer: captured text for ${name} is ${sees ? "returned" : "withheld"}`, async () => {
    const searchEvent = eventRow({
      type: "search",
      toolId: null,
      query: "refund my order 1234",
      payload: { query: "refund my order 1234" },
    });
    const registry = buildRegistry(
      developerOperations(
        deps({
          contentOptIn: async () => optIn,
          listRuntimeEvents: async () => [searchEvent],
          getRuntimeEvent: async () => searchEvent,
        }),
      ),
    );
    const call = async (id: string, params: Record<string, unknown>) => {
      const result = await dispatchOperation(
        id,
        { projectId: PROJECT, ...params },
        { registry, auth: caller, logger: quiet },
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      return result as { ok: true; data: Record<string, unknown>; hint?: string };
    };

    const one = await call("get_sdk_event", { identifier: "evt-1" });
    const list = await call("list_sdk_events", {});
    const listed = (list.data.events as Record<string, unknown>[])[0]!;
    const event = one.data.event as Record<string, unknown>;

    assert.equal(
      one.data.payloadChars,
      JSON.stringify(searchEvent.payload).length,
      "the size is a fact, not text",
    );
    assert.equal(event.type, "search");
    if (sees) {
      assert.deepEqual(JSON.parse(String(one.data.payload)), { query: "refund my order 1234" });
      assert.equal(event.subject, "refund my order 1234");
      assert.equal(listed.subject, "refund my order 1234");
      assert.equal(one.data.contentWithheld, undefined);
    } else {
      assert.equal(one.data.payload, null);
      assert.equal(event.subject, null);
      assert.equal(listed.subject, null);
      assert.equal(one.data.contentWithheld, true);
      assert.equal(list.data.contentWithheld, true);
      assert.match(one.hint ?? "", /signed-in members/);
    }
  });
}

/* ------------------- get_sdk_setup: deploy watch copy (RC-921) ------------------- */

test("get_sdk_setup tells the reader to set service.version to the commit sha", async () => {
  const { data, hint } = await run("get_sdk_setup", {});
  const snippets = data.snippets as Array<{ lang: string; code: string }>;
  assert.match(snippets[0]?.code ?? "", /service\.version to the commit sha of the deploy/);
  assert.match(snippets[0]?.code ?? "", /OTEL_RESOURCE_ATTRIBUTES=service\.version=\$GITHUB_SHA/);
  assert.match(
    hint ?? "",
    /Set service\.version to the commit sha of the deploy \(for example GITHUB_SHA\)/,
  );
});
