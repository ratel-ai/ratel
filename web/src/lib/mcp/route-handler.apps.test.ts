import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resetConfigForTests, resolveConfig } from "@/config";
import { buildMcpAppCatalog, type McpAppCatalog } from "@/lib/mcp/apps/catalog";
import { VIEW_SESSION_PREFIX } from "@/lib/mcp/apps/client-views";
import { mcpAppsEnabled } from "@/lib/mcp/apps/flag";
import { loadMcpAppCatalog, readGeneratedViews } from "@/lib/mcp/apps/load";
import {
  BINDING_META_KEY,
  MCP_APP_MIME_TYPE,
  type McpAppView,
  VIEW_META_KEY,
} from "@/lib/mcp/apps/types";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { McpOperationError } from "@/lib/mcp/errors";
import { createMcpRouteHandler, type McpRouteDeps } from "@/lib/mcp/route-handler";
import { asToolResult, VIEW_INSTRUCTIONS, viewHint } from "@/lib/mcp/server";
import { STAGE_META_KEY } from "@/lib/mcp/stages";
import { createTokenBucketRateLimiter } from "@/lib/platform/rate-limit";

/**
 * MCP Apps over the real POST /api/mcp handler (`mcpApps`): with the
 * switch on, ui:// views are listed and read and bound tools point at them;
 * with it off, the protocol surface is exactly what main serves.
 *
 * Owned (ADR-0030): upstream's cases, with the gate the env switch. Upstream's
 * cases for its flag service (a hung or slow lookup, the caller's identity)
 * have no counterpart: reading the environment neither waits nor fails.
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

const PINNED_TOOLS: Array<
  Record<string, unknown> & { name: string; _meta?: Record<string, unknown> }
> = JSON.parse(readFileSync(new URL("./__fixtures__/tools-list.json", import.meta.url), "utf8"));
const STAGED_TOOL = PINNED_TOOLS.find((tool) => tool._meta?.[STAGE_META_KEY])!.name;
const UNSTAGED_TOOL = PINNED_TOOLS.find(
  (tool) => !tool._meta && tool.name !== "whoami" && tool.name !== "get_flag_status",
)!.name;

const HTML =
  "<!doctype html><html><head><title>list</title></head><body><div id=root></div></body></html>";
const VIEWS: McpAppView[] = [
  {
    view: "list",
    title: "List",
    html: HTML,
    bindings: [{ tool: STAGED_TOOL, config: { columns: ["name"] } }, { tool: UNSTAGED_TOOL }],
  },
  {
    view: "detail",
    html: "<!doctype html><html><body>detail</body></html>",
    bindings: [{ tool: "whoami" }, { tool: "get_flag_status" }],
  },
];
const catalog: McpAppCatalog = buildMcpAppCatalog(
  VIEWS,
  new Set(PINNED_TOOLS.map((tool) => tool.name)),
);

function deps(overrides: Partial<McpRouteDeps> = {}): McpRouteDeps {
  return {
    authenticate: async () => ({ ok: true, auth }),
    credentialLimiter: createTokenBucketRateLimiter({ limitPerMinute: 20, burst: 40 }),
    perKeyLimiter: createTokenBucketRateLimiter({ limitPerMinute: 60, burst: 120 }),
    globalLimiter: createTokenBucketRateLimiter({ limitPerMinute: 600, burst: 900 }),
    trackServerEvent: (async () => undefined) as never,
    launchAccess: async () => true,
    appCatalog: () => catalog,
    ...overrides,
  };
}

const flagOn = deps({ mcpApps: async () => true });
/** Off through the real gate: the switch unset. */
const flagOff = deps({ mcpApps: (caller) => mcpAppsEnabled(caller, resolveConfig()) });

function rpc(
  method: string,
  params: unknown = {},
  headers: Record<string, string> = { authorization: "Bearer rtl_test" },
) {
  return new Request("https://cloud.ratel.sh/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function call(
  routeDeps: McpRouteDeps,
  method: string,
  params: unknown = {},
  headers: Record<string, string> = {},
) {
  const response = await createMcpRouteHandler(routeDeps)(
    rpc(method, params, { authorization: "Bearer rtl_test", ...headers }),
  );
  return { response, body: await response.json() };
}

const INITIALIZE = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "test-client", version: "1.0.0" },
};

/** As Claude Desktop initializes (its log, through mcp-remote 0.16.6): it shows MCP Apps views. */
const INITIALIZE_WITH_VIEWS = {
  protocolVersion: "2025-11-25",
  capabilities: {
    roots: { listChanged: true },
    extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [MCP_APP_MIME_TYPE] } },
  },
  clientInfo: { name: "local-agent-mode-ratel-local (via mcp-remote 0.16.6)", version: "1.0.0" },
};

/**
 * initialize and resources/list as main answers them, captured from main's
 * server.ts and route-handler.ts. tools/list is pinned by tools-list.json.
 * Regenerate deliberately with `UPDATE_MCP_APPS_FIXTURE=1` and review the diff.
 */
const FLAG_OFF_FIXTURE = new URL("./__fixtures__/flag-off-protocol.json", import.meta.url);

test("flag off: initialize, tools/list and resources/list are unchanged from main", async () => {
  const initialize = (await call(flagOff, "initialize", INITIALIZE)).body;
  const resourcesList = (await call(flagOff, "resources/list")).body;
  const tools = (await call(flagOff, "tools/list")).body.result.tools;

  if (process.env.UPDATE_MCP_APPS_FIXTURE === "1") {
    writeFileSync(FLAG_OFF_FIXTURE, `${JSON.stringify({ initialize, resourcesList }, null, 2)}\n`);
    return;
  }
  const pinned = JSON.parse(readFileSync(FLAG_OFF_FIXTURE, "utf8"));
  assert.deepEqual(initialize, pinned.initialize);
  assert.deepEqual(resourcesList, pinned.resourcesList);
  assert.deepEqual(tools, PINNED_TOOLS);
});

test("flag off: a bound tool's result carries no binding _meta", async () => {
  const { body } = await call(flagOff, "tools/call", { name: "get_flag_status", arguments: {} });
  assert.ok(body.result.structuredContent);
  assert.equal(body.result._meta, undefined);
});

test("flag on: initialize declares resources next to tools", async () => {
  const { body } = await call(flagOn, "initialize", INITIALIZE);
  assert.ok(body.result.capabilities.tools);
  assert.ok(body.result.capabilities.resources);
});

test("flag on, a client that shows views: the instructions say the person sees the data; otherwise they are main's", async () => {
  const shows = await call(flagOn, "initialize", INITIALIZE_WITH_VIEWS);
  const plain = (await call(flagOn, "initialize", INITIALIZE)).body.result.instructions as string;
  const off = (await call(flagOff, "initialize", INITIALIZE_WITH_VIEWS)).body.result
    .instructions as string;
  const on = shows.body.result.instructions as string;
  assert.ok(on.endsWith(`\n\n${VIEW_INSTRUCTIONS}`));
  assert.equal(on.slice(0, -`\n\n${VIEW_INSTRUCTIONS}`.length), off);
  assert.equal(plain, off, "a client without views (Claude Code) reads main's instructions");
  assert.doesNotMatch(VIEW_INSTRUCTIONS, /Claude|ChatGPT|Desktop|MCP Apps/);
});

test("a client that shows views gets a session id saying so; others, and flag off, get none", async () => {
  const id = (await call(flagOn, "initialize", INITIALIZE_WITH_VIEWS)).response.headers.get(
    "mcp-session-id",
  );
  assert.match(id ?? "", new RegExp(`^${VIEW_SESSION_PREFIX}[0-9a-f-]{36}$`));
  assert.equal(
    (await call(flagOn, "initialize", INITIALIZE)).response.headers.get("mcp-session-id"),
    null,
  );
  assert.equal(
    (await call(flagOff, "initialize", INITIALIZE_WITH_VIEWS)).response.headers.get(
      "mcp-session-id",
    ),
    null,
  );
  assert.equal(
    (await call(flagOn, "tools/list", {}, { "mcp-session-id": id! })).response.headers.get(
      "mcp-session-id",
    ),
    null,
    "issued once, at initialize",
  );
});

test("flag off, a client that shows views: initialize's headers and body are main's", async () => {
  const pinned = JSON.parse(readFileSync(FLAG_OFF_FIXTURE, "utf8"));
  // The same initialize without the MCP Apps extension: what main answers this client.
  const plain = await call(flagOff, "initialize", { ...INITIALIZE_WITH_VIEWS, capabilities: {} });
  const ui = await call(flagOff, "initialize", INITIALIZE_WITH_VIEWS);
  assert.deepEqual(ui.body, plain.body, "the extension changes nothing");
  assert.equal(
    ui.body.result.instructions,
    pinned.initialize.result.instructions,
    "main's instructions",
  );
  assert.deepEqual(
    ui.body.result.capabilities,
    pinned.initialize.result.capabilities,
    "tools only",
  );
  assert.deepEqual([...ui.response.headers.entries()], [...plain.response.headers.entries()]);
  assert.deepEqual(
    [...ui.response.headers.entries()],
    [["content-type", "application/json"]],
    "no Mcp-Session-Id: the one header main sends",
  );
  // A views session id sent back changes nothing either.
  const later = await call(
    flagOff,
    "tools/list",
    {},
    { "mcp-session-id": `${VIEW_SESSION_PREFIX}00000000-0000-4000-8000-000000000000` },
  );
  assert.deepEqual(later.body.result.tools, PINNED_TOOLS);
  assert.deepEqual([...later.response.headers.entries()], [["content-type", "application/json"]]);
});

test("flag on: a bound tool's success tells a client that shows views; an error, a client without views and flag off do not", async () => {
  const session = (await call(flagOn, "initialize", INITIALIZE_WITH_VIEWS)).response.headers.get(
    "mcp-session-id",
  )!;
  const args = { name: "get_flag_status", arguments: {} };
  const shows = (await call(flagOn, "tools/call", args, { "mcp-session-id": session })).body.result;
  const plain = (await call(flagOn, "tools/call", args)).body.result;
  const off = (await call(flagOff, "tools/call", args, { "mcp-session-id": session })).body.result;
  assert.deepEqual(shows.content[1], { type: "text", text: viewHint("detail") });
  assert.equal(shows.content[0].text, off.content[0].text);
  assert.equal(
    plain.content.length,
    1,
    "Claude Code and other clients without views read main's content",
  );
  assert.equal(off.content.length, 1);

  // A client on the stateless protocol says it on the request itself.
  const stateless = (
    await call(flagOn, "tools/call", {
      ...args,
      _meta: { "io.modelcontextprotocol/clientCapabilities": INITIALIZE_WITH_VIEWS.capabilities },
    })
  ).body.result;
  assert.deepEqual(stateless.content[1], { type: "text", text: viewHint("detail") });

  const failed = asToolResult(
    { ok: false, error: "not_found", message: "No." },
    true,
    undefined,
    viewHint("detail"),
  );
  assert.equal(failed.content.length, 1);
});

test("flag on: resources/list returns every view as ui://ratel/<view>", async () => {
  const { response, body } = await call(flagOn, "resources/list");
  assert.equal(response.status, 200);
  assert.deepEqual(body.result.resources, [
    { uri: "ui://ratel/list", name: "list", title: "List", mimeType: MCP_APP_MIME_TYPE },
    { uri: "ui://ratel/detail", name: "detail", title: "detail", mimeType: MCP_APP_MIME_TYPE },
  ]);
});

test("flag on: resources/read returns the view's HTML as an MCP App, with this app's origin for its links", async () => {
  const { body } = await call(flagOn, "resources/read", { uri: "ui://ratel/list" });
  const text = HTML.replace(
    "<head>",
    '<head><meta name="ratel-console-origin" content="https://cloud.ratel.sh">',
  );
  assert.deepEqual(body.result.contents, [
    { uri: "ui://ratel/list", mimeType: MCP_APP_MIME_TYPE, text },
  ]);
});

test("views link to the origin the app is served on (a local run is localhost)", async () => {
  const previous = process.env.APP_PUBLIC_URL;
  process.env.APP_PUBLIC_URL = "http://localhost:3100/";
  resetConfigForTests();
  try {
    const { body } = await call(flagOn, "resources/read", { uri: "ui://ratel/list" });
    assert.match(
      body.result.contents[0].text,
      /<meta name="ratel-console-origin" content="http:\/\/localhost:3100">/,
    );
  } finally {
    if (previous === undefined) delete process.env.APP_PUBLIC_URL;
    else process.env.APP_PUBLIC_URL = previous;
    resetConfigForTests();
  }
});

test("flag on: an unknown ui:// URI is a clean JSON-RPC error", async () => {
  const { response, body } = await call(flagOn, "resources/read", { uri: "ui://ratel/nope" });
  assert.equal(response.status, 200);
  assert.equal(body.result, undefined);
  assert.equal(body.error.code, -32602);
  assert.match(body.error.message, /ui:\/\/ratel\/nope not found/);
});

test("flag on: a bound tool carries ui.resourceUri and keeps its stage", async () => {
  const { body } = await call(flagOn, "tools/list");
  const tools = new Map<string, { _meta?: Record<string, unknown> }>(
    body.result.tools.map((tool: { name: string }) => [tool.name, tool]),
  );
  const pinnedStage = PINNED_TOOLS.find((tool) => tool.name === STAGED_TOOL)!._meta![
    STAGE_META_KEY
  ];
  assert.deepEqual(tools.get(STAGED_TOOL)!._meta, {
    [STAGE_META_KEY]: pinnedStage,
    ui: { resourceUri: "ui://ratel/list" },
  });
  assert.deepEqual(tools.get(UNSTAGED_TOOL)!._meta, { ui: { resourceUri: "ui://ratel/list" } });
  assert.deepEqual(tools.get("whoami")!._meta, { ui: { resourceUri: "ui://ratel/detail" } });

  // Everything else is listed exactly as with the flag off.
  assert.deepEqual(tools.get("get_flag_status")!._meta, {
    ui: { resourceUri: "ui://ratel/detail" },
  });
  const bound = new Set([STAGED_TOOL, UNSTAGED_TOOL, "whoami", "get_flag_status"]);
  for (const pinned of PINNED_TOOLS.filter((tool) => !bound.has(tool.name))) {
    assert.deepEqual(tools.get(pinned.name), pinned, pinned.name);
  }
});

test("flag on: a bound tool's result names its binding, text content untouched", async () => {
  // get_flag_status answers without a database.
  const { body } = await call(flagOn, "tools/call", { name: "get_flag_status", arguments: {} });
  assert.deepEqual(body.result._meta, {
    [BINDING_META_KEY]: { view: "detail", tool: "get_flag_status" },
  });
  assert.equal(body.result.content[0].text, JSON.stringify(body.result.structuredContent, null, 2));
});

test("resources need the same credential as tools", async () => {
  const handler = createMcpRouteHandler(
    deps({
      mcpApps: async () => true,
      authenticate: async () => ({
        ok: false,
        error: new McpOperationError("unauthorized", "Missing credential."),
      }),
    }),
  );
  for (const [method, params] of [
    ["resources/list", {}],
    ["resources/read", { uri: "ui://ratel/list" }],
  ] as const) {
    const response = await handler(rpc(method, params, {}));
    assert.equal(response.status, 401, method);
    assert.ok(response.headers.get("www-authenticate"), method);
  }
});

test("resources are refused at the door to someone without app access", async () => {
  let asked = false;
  const handler = createMcpRouteHandler(
    deps({
      mcpApps: async () => {
        asked = true;
        return true;
      },
      authenticate: async () => ({
        ok: true,
        auth: { kind: "oauth", externalUserId: "user_no_access", userId: "row-1", memberships: [] },
      }),
      launchAccess: async () => false,
    }),
  );
  const response = await handler(rpc("resources/read", { uri: "ui://ratel/list" }));
  assert.equal(response.status, 403);
  assert.equal(asked, false, "the flag is not even asked before the door");
});

test("a view build that fails its checks serves the server without views", async () => {
  const { body } = await call(
    deps({
      mcpApps: async () => true,
      appCatalog: () => {
        throw new Error("bad build");
      },
    }),
    "tools/list",
  );
  assert.deepEqual(body.result.tools, PINNED_TOOLS);
});

/** A views.json as a broken or missing build leaves it, read by the real loader. */
function catalogFromFile(contents: string | null) {
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-views-"));
  const file = path.join(dir, "views.json");
  if (contents !== null) writeFileSync(file, contents);
  return () =>
    loadMcpAppCatalog({
      readViews: () => readGeneratedViews(file),
      toolIds: () => new Set(PINNED_TOOLS.map((tool) => tool.name)),
    });
}

for (const [name, contents] of [
  ["missing", null],
  ["not JSON", "{ views: oops"],
  ["not an array", '{"view":"list"}'],
  [
    "a binding to an unknown tool",
    JSON.stringify([{ view: "list", html: HTML, bindings: [{ tool: "no_such_tool" }] }]),
  ],
] as const) {
  test(`flag on with a views.json that is ${name}: initialize, tools/list and resources/list are main's`, async () => {
    const broken = deps({ mcpApps: async () => true, appCatalog: catalogFromFile(contents) });
    const pinned = JSON.parse(readFileSync(FLAG_OFF_FIXTURE, "utf8"));
    assert.deepEqual((await call(broken, "initialize", INITIALIZE)).body, pinned.initialize);
    assert.deepEqual((await call(broken, "resources/list")).body, pinned.resourcesList);
    assert.deepEqual((await call(broken, "tools/list")).body.result.tools, PINNED_TOOLS);
    const result = (await call(broken, "tools/call", { name: "get_flag_status", arguments: {} }))
      .body.result;
    assert.equal(result._meta, undefined, "no binding on a result");
  });
}

test("the real gate reads mcpApps: on lists the views, unset serves main's server", async () => {
  const on = deps({
    mcpApps: (caller) =>
      mcpAppsEnabled(caller, resolveConfig({ override: { flags: { mcpApps: true } } })),
  });
  assert.equal((await call(on, "resources/list")).body.result.resources.length, VIEWS.length);
  const pinned = JSON.parse(readFileSync(FLAG_OFF_FIXTURE, "utf8"));
  assert.deepEqual((await call(flagOff, "resources/list")).body, pinned.resourcesList);
});

test("flag on: the replay's step content tool is listed for the views only; flag off it is not there", async () => {
  const on = (await call(flagOn, "tools/list")).body.result.tools as Array<{
    name: string;
    _meta?: Record<string, unknown>;
  }>;
  assert.deepEqual(on.find((tool) => tool.name === "get_session_step_content")?._meta, {
    ui: { visibility: ["app"] },
  });
  const off = (await call(flagOff, "tools/list")).body.result.tools as Array<{ name: string }>;
  assert.equal(
    off.some((tool) => tool.name === "get_session_step_content"),
    false,
  );
});

test("a result's view data reaches _meta only, never the text or structuredContent the agent reads", () => {
  const binding = { [BINDING_META_KEY]: { view: "replay", tool: "get_session" } };
  const result = asToolResult(
    {
      ok: true,
      operation_id: "get_session",
      data: { sessionId: "s" },
      view: { kind: "session_chat" },
    },
    false,
    binding,
  );
  const body = { ok: true, operation_id: "get_session", data: { sessionId: "s" } };
  assert.deepEqual(JSON.parse(result.content[0].text), body);
  assert.deepEqual(result.structuredContent, body);
  assert.deepEqual(result._meta, { ...binding, [VIEW_META_KEY]: { kind: "session_chat" } });
});
