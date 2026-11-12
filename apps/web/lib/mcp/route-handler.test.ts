import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { McpOperationError } from "@/lib/mcp/errors";
import { assembleOperations } from "@/lib/mcp/operations";
import {
  createMcpRouteHandler,
  type McpRouteDeps,
  methodNotAllowed,
} from "@/lib/mcp/route-handler";
import { STAGE_META_KEY, TOOL_STAGES } from "@/lib/mcp/stages";
import { createTokenBucketRateLimiter } from "@/lib/platform/rate-limit";

/**
 * End-to-end protocol coverage.
 *
 * Route handlers are plain functions, so a real MCP conversation can be driven
 * without a server: build JSON-RPC envelopes, call the handler, assert on the
 * responses. This is the test that would catch a client failing to connect.
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

function deps(overrides: Partial<McpRouteDeps> = {}): McpRouteDeps {
  return {
    authenticate: async () => ({ ok: true, auth }),
    credentialLimiter: createTokenBucketRateLimiter({ limitPerMinute: 20, burst: 40 }),
    perKeyLimiter: createTokenBucketRateLimiter({ limitPerMinute: 60, burst: 120 }),
    globalLimiter: createTokenBucketRateLimiter({ limitPerMinute: 600, burst: 900 }),
    trackServerEvent: (async () => undefined) as never,
    loopEnabled: async () => true,
    ...overrides,
  };
}

function rpc(method: string, params: unknown = {}, id: number | null = 1) {
  return new Request("https://cloud.ratel.sh/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer rtl_test" },
    body: JSON.stringify(
      id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params },
    ),
  });
}

async function call(method: string, params: unknown = {}, id: number | null = 1) {
  const handler = createMcpRouteHandler(deps());
  const response = await handler(rpc(method, params, id));
  return { response, body: response.status === 202 ? null : await response.json() };
}

test("initialize negotiates and advertises the tools capability", async () => {
  const { response, body } = await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  });

  assert.equal(response.status, 200);
  assert.equal(body.jsonrpc, "2.0");
  assert.ok(body.result.capabilities.tools, "must advertise tools");
  assert.equal(body.result.serverInfo.name, "ratel");
  assert.ok(body.result.instructions.length > 0);
});

test("an older protocol version still negotiates", async () => {
  const { body } = await call("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "old-client", version: "1.0.0" },
  });

  assert.ok(body.result.protocolVersion);
});

test("tools/list exposes every operation as its own tool, plus whoami", async () => {
  const { body } = await call("tools/list");
  const names: string[] = body.result.tools.map((tool: { name: string }) => tool.name);

  assert.equal(
    names.length,
    assembleOperations().length + 1,
    "one tool per operation, plus whoami",
  );
  assert.ok(names.includes("whoami"));
  // Named for what they do, so a client's tool picker is readable.
  for (const expected of ["list_traces", "get_cost_by_day", "get_improvement_signals"]) {
    assert.ok(names.includes(expected), `${expected} should be directly callable`);
  }
  assert.ok(!names.includes("execute_operation"), "the gateway façade is gone");
});

/**
 * The tools/list surface before the improvement-loop tools, captured from this build's route
 * handler. With the loop off, nothing a client sees may differ: same tools, same names, titles,
 * descriptions, schemas and annotations, and no `_meta`.
 */
const TOOLS_BEFORE_LOOP: Array<Record<string, unknown> & { name: string }> = JSON.parse(
  readFileSync(new URL("./__fixtures__/tools-list-before-loop.json", import.meta.url), "utf8"),
);

test("with the loop off, the loop tools are not listed", async () => {
  const handler = createMcpRouteHandler(deps({ loopEnabled: async () => false }));
  const body = await (await handler(rpc("tools/list"))).json();
  const names: string[] = body.result.tools.map((tool: { name: string }) => tool.name);
  for (const hidden of [
    "list_insights",
    "get_fix",
    "run_eval",
    "create_experiment",
    "mark_fix_shipped",
  ]) {
    assert.ok(!names.includes(hidden), `${hidden} should be hidden without the flag`);
  }
  assert.ok(names.includes("list_traces"));
});

test("with the loop off, every tool definition is exactly what it was before the loop", async () => {
  const handler = createMcpRouteHandler(deps({ loopEnabled: async () => false }));
  const body = await (await handler(rpc("tools/list"))).json();
  const tools: Array<Record<string, unknown> & { name: string }> = body.result.tools;

  assert.deepEqual(
    tools.filter((tool) => "_meta" in tool).map((tool) => tool.name),
    [],
    "no tool publishes _meta with the flag off",
  );
  assert.deepEqual(tools, TOOLS_BEFORE_LOOP, "the whole flag-off list, order included");
});

test("each tool in the loop publishes its stage as metadata", async () => {
  const { body } = await call("tools/list");
  const tools: Array<{ name: string; _meta?: Record<string, unknown> }> = body.result.tools;

  assert.equal(
    tools.find((tool) => tool.name === "list_traces")?._meta?.["sh.ratel/stage"],
    "monitor",
  );
  assert.equal(
    tools.find((tool) => tool.name === "list_insights")?._meta?.["sh.ratel/stage"],
    "insights",
  );
  assert.equal(
    tools.find((tool) => tool.name === "run_eval")?._meta?.["sh.ratel/stage"],
    "improve",
  );
  assert.equal(
    tools.find((tool) => tool.name === "mark_fix_shipped")?._meta?.["sh.ratel/stage"],
    "ship",
  );
});

test("with the loop on, an existing tool changes only by its stage _meta", async () => {
  const { body } = await call("tools/list");
  const listed = new Map<string, Record<string, unknown>>(
    body.result.tools.map((tool: Record<string, unknown> & { name: string }) => [tool.name, tool]),
  );
  let staged = 0;
  for (const before of TOOLS_BEFORE_LOOP) {
    const { _meta, ...rest } = listed.get(before.name) ?? {};
    assert.deepEqual(rest, before, `${before.name} keeps its definition`);
    const stage = TOOL_STAGES[before.name];
    assert.deepEqual(
      _meta,
      stage ? { [STAGE_META_KEY]: stage } : undefined,
      `${before.name} publishes its stage, and only that`,
    );
    if (stage) staged++;
  }
  assert.ok(staged > 0, "existing tools carry a stage with the flag on");
});

test("each tool publishes a schema and a read-only or mutating annotation", async () => {
  const { body } = await call("tools/list");
  const tools: Array<{
    name: string;
    inputSchema?: unknown;
    annotations?: { readOnlyHint?: boolean };
  }> = body.result.tools;

  const traces = tools.find((tool) => tool.name === "list_traces");
  assert.ok(traces?.inputSchema, "a client needs the schema to build a call");
  assert.equal(traces?.annotations?.readOnlyHint, true);

  const write = tools.find((tool) => tool.name === "create_skill");
  assert.equal(write?.annotations?.readOnlyHint, false, "writes must not claim to be read-only");
});

test("calling a tool runs its operation and reports failures in-band", async () => {
  const { response, body } = await call("tools/call", {
    name: "get_skill",
    arguments: { skillId: "11111111-1111-4111-8111-111111111111" },
  });

  // JSON-RPC succeeds; the tool result carries the domain failure, which is
  // what lets the model read and react to it.
  assert.equal(response.status, 200);
  assert.equal(body.result.isError, true);
  assert.ok(body.result.structuredContent.error);
});

test("an unregistered tool name is refused by the transport", async () => {
  const { body } = await call("tools/call", { name: "no_such_tool", arguments: {} });

  assert.ok(body.error || body.result?.isError, "must not silently succeed");
});

test("a notification is accepted with no body", async () => {
  const { response } = await call("notifications/initialized", {}, null);

  assert.equal(response.status, 202);
});

test("a missing credential is rejected before any protocol work", async () => {
  const handler = createMcpRouteHandler(
    deps({
      authenticate: async () => ({
        ok: false,
        error: new McpOperationError("unauthorized", "Missing credential."),
      }),
    }),
  );
  const response = await handler(rpc("tools/list"));

  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /Bearer/);
});

/**
 * Nothing is behind a flag any more, the endpoint included. Every caller that
 * authenticates gets in; which projects it can then reach is still decided per
 * call, by its key or by its memberships.
 */
test("every authenticated caller reaches the endpoint, with no flag to switch it on", async () => {
  const member: McpAuthContext = {
    kind: "oauth",
    externalUserId: "user_123",
    userId: "u1",
    memberships: [
      {
        organizationId: "org-1",
        role: "admin",
        organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
      },
    ],
  };

  for (const caller of [auth, member]) {
    const handler = createMcpRouteHandler(
      deps({ authenticate: async () => ({ ok: true, auth: caller }) }),
    );
    const response = await handler(rpc("tools/list"));
    const body = await response.json();

    assert.equal(response.status, 200, `a ${caller.kind} caller must get in`);
    assert.ok(body.result.tools.length > 0);
  }
});

/**
 * Kept because a client that connected before the flags were retired still
 * holds it in its cached tool list (compatibility.test.ts pins the name). The
 * answer is now fixed, and it must stay an answer rather than an error.
 */
test("get_flag_status still answers, and says nothing is behind a flag", async () => {
  const { response, body } = await call("tools/call", { name: "get_flag_status", arguments: {} });

  assert.equal(response.status, 200);
  assert.ok(!body.result.isError, "an old client asking must not be told it failed");
  assert.deepEqual(body.result.structuredContent.data, { count: 0, flags: [] });
  assert.match(body.result.structuredContent.hint, /[Nn]othing is behind a flag/);
});

test("an exhausted rate limit returns 429 with Retry-After", async () => {
  const limiter = createTokenBucketRateLimiter({ limitPerMinute: 1, burst: 1 });
  const handler = createMcpRouteHandler(deps({ perKeyLimiter: limiter }));

  await handler(rpc("tools/list"));
  const response = await handler(rpc("tools/list"));

  assert.equal(response.status, 429);
  assert.ok(response.headers.get("retry-after"));
});

test("malformed JSON gets the reserved parse-error code", async () => {
  const handler = createMcpRouteHandler(deps());
  const response = await handler(
    new Request("https://cloud.ratel.sh/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer rtl_test" },
      body: "{not json",
    }),
  );
  const body = await response.json();

  assert.equal(body.error.code, -32700);
});

test("an oversized batch is refused rather than amplified", async () => {
  const handler = createMcpRouteHandler(deps());
  const response = await handler(
    new Request("https://cloud.ratel.sh/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer rtl_test" },
      body: JSON.stringify(
        Array.from({ length: 6 }, (_, index) => ({
          jsonrpc: "2.0",
          id: index,
          method: "tools/list",
        })),
      ),
    }),
  );

  assert.equal(response.status, 400);
});

test("GET and DELETE explain that this endpoint is stateless", async () => {
  const response = methodNotAllowed();
  const body = await response.json();

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.match(body.message, /stateless/);
});

/**
 * A real client got HTTP 500 here after a successful browser sign-in, because
 * token verification went through the identity provider's `auth()`, which
 * throws when it cannot find its middleware in the request. The client reported
 * "Got new credentials, but reconnecting failed" and stopped, since a server
 * error is not something it can re-authenticate its way out of.
 */
test("an exception while verifying a credential is a 401, never a 500", async () => {
  const handler = createMcpRouteHandler(
    deps({
      authenticate: async () => {
        throw new Error("auth() was called but the provider can't detect its middleware()");
      },
    }),
  );
  const response = await handler(rpc("tools/list"));
  const body = await response.json();

  assert.equal(response.status, 401, "a client can act on 401; it cannot act on 500");
  assert.equal(body.error, "unauthorized");
  assert.ok(!body.message.includes("middleware"), "internal detail must not reach the client");
});

test("the 401 from a failed verification still advertises where to authenticate", async () => {
  const handler = createMcpRouteHandler(
    deps({
      authenticate: async () => {
        throw new Error("boom");
      },
    }),
  );
  const response = await handler(rpc("tools/list"));

  // Without this the client has a 401 and nowhere to go, which is the same
  // dead end as having no challenge at all.
  assert.match(
    response.headers.get("www-authenticate") ?? "",
    /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/api\/mcp"/,
  );
});

/**
 * Rejecting a bad credential is not free work, and until this budget existed
 * nothing metered it. An `rtl_` guess costs a database lookup; anything else is
 * treated as a Clerk token and costs an outbound call to Clerk. Both were
 * reachable by anyone, at any rate, with no credential at all.
 */
function anonymousRequest(address = "203.0.113.9"): Request {
  return new Request("https://cloud.ratel.sh/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer rtl_wrong",
      "x-forwarded-for": address,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

const rejected: McpRouteDeps["authenticate"] = async () => ({
  ok: false,
  error: new McpOperationError("unauthorized", "Invalid, expired, or revoked API key."),
});

test("repeated bad credentials stop reaching the authenticator at all", async () => {
  let attempts = 0;
  const handler = createMcpRouteHandler(
    deps({
      authenticate: async (...args) => {
        attempts += 1;
        return rejected(...args);
      },
      credentialLimiter: createTokenBucketRateLimiter({ limitPerMinute: 60, burst: 2 }),
    }),
  );

  assert.equal((await handler(anonymousRequest())).status, 401);
  assert.equal((await handler(anonymousRequest())).status, 401);
  const throttled = await handler(anonymousRequest());

  assert.equal(throttled.status, 429);
  assert.ok(throttled.headers.get("retry-after"));
  assert.equal(attempts, 2, "the third attempt must not cost a credential lookup");
});

test("the failure budget is per address, so one attacker cannot lock others out", async () => {
  const handler = createMcpRouteHandler(
    deps({
      authenticate: rejected,
      credentialLimiter: createTokenBucketRateLimiter({ limitPerMinute: 60, burst: 1 }),
    }),
  );

  await handler(anonymousRequest("203.0.113.9"));
  assert.equal((await handler(anonymousRequest("203.0.113.9"))).status, 429);
  assert.equal(
    (await handler(anonymousRequest("198.51.100.4"))).status,
    401,
    "a different address must still get a real answer",
  );
});

test("successful calls are never charged to the failure budget", async () => {
  // A busy office behind one NAT address would otherwise throttle itself out
  // of a surface it is authenticating to correctly every time.
  const handler = createMcpRouteHandler(
    deps({ credentialLimiter: createTokenBucketRateLimiter({ limitPerMinute: 60, burst: 1 }) }),
  );

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await handler(rpc("tools/list"))).status, 200);
  }
});

test("a refusal before dispatch is still counted, not just the ones after it", async () => {
  const events: Array<{ name: string; properties: Record<string, unknown> }> = [];
  const handler = createMcpRouteHandler(
    deps({
      perKeyLimiter: createTokenBucketRateLimiter({ limitPerMinute: 1, burst: 1 }),
      trackServerEvent: (async (
        name: string,
        _context: unknown,
        properties: Record<string, unknown>,
      ) => {
        events.push({ name, properties });
      }) as never,
    }),
  );

  await handler(rpc("tools/list"));
  await handler(rpc("tools/list"));

  const denial = events.find((event) => event.name === "mcp_operation_denied");
  assert.ok(denial, "a rate-limited request must reach the denial dashboard");
  assert.equal(denial.properties.outcome, "rate_limited");
  assert.equal(denial.properties.stage, "transport");
  assert.equal(denial.properties.scope, "per_credential");
});

test("an unconfigured database does not spend the caller's failure budget", async () => {
  // Refused before any lookup, so it costs us nothing and must cost them
  // nothing: replacing "database not configured" with "you have retried too
  // often" would blame the caller for our outage.
  const handler = createMcpRouteHandler(
    deps({
      authenticate: async () => ({
        ok: false,
        error: new McpOperationError("unavailable", "Not available. Database not configured."),
      }),
      credentialLimiter: createTokenBucketRateLimiter({ limitPerMinute: 60, burst: 1 }),
    }),
  );

  await handler(anonymousRequest());
  const second = await handler(anonymousRequest());

  assert.equal(second.status, 503);
  assert.equal((await second.json()).error, "unavailable");
});
