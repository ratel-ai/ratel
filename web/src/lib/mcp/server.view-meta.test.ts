import assert from "node:assert/strict";
import { test } from "node:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildMcpAppCatalog } from "@/lib/mcp/apps/catalog";
import { readGeneratedViews } from "@/lib/mcp/apps/load";
import { BINDING_META_KEY, type McpAppView, VIEW_META_KEY } from "@/lib/mcp/apps/types";
import { buildRequestRegistry } from "@/lib/mcp/operations";
import { buildRegistry, type McpOperation } from "@/lib/mcp/registry";
import type { McpAuthContext } from "./auth";
import { createRatelMcpServer, viewHint } from "./server";
import { SingleMessageTransport } from "./transport";

/**
 * RW-47: a view's own model (OperationResult.view) never reaches the model.
 * For every tool a published view binds, the result's content and
 * structuredContent are byte-identical with `mcpApps` on and off; with
 * it on, `_meta` carries the view under `sh.ratel/view`. RW-48: flag on, a
 * success adds one line after them, as its own text block, saying a view may
 * be showing the data; the data block itself is untouched.
 *
 * Each operation keeps its real id and registration but answers from a stub
 * that returns a `view` whenever it renders for one (the worst case: in the
 * registry only get_trace, get_session, get_run_summary and
 * get_trace_conversation do). That the real operations return the same `data`
 * with forView is pinned in their own tests (observability, runs, ship).
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";
const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

// The published views as the @ratel/mcp-apps build lists them (`pnpm test` builds it first), with
// a stand-in document: this test pins the server, not the views' HTML.
const BUILT = readGeneratedViews();
if (!BUILT)
  throw new Error("mcp-apps views are not built: run pnpm --filter @ratel/mcp-apps build");
const VIEWS: McpAppView[] = BUILT.map(({ view, title, bindings }) => ({
  view,
  ...(title ? { title } : {}),
  html: `<!doctype html><html><head></head><body>${view}</body></html>`,
  bindings,
}));
const BOUND = VIEWS.flatMap((view) => view.bindings.map((binding) => binding.tool));

const VIEW_MODEL = { kind: "session_chat", chat: { turns: [{ text: "x".repeat(2000) }] } };

function stubbed(operation: McpOperation): McpOperation {
  return {
    ...operation,
    scope: "none",
    params: z.object({}).passthrough(),
    execute: async (ctx) => ({
      data: { tool: operation.id, rows: [{ id: 1, name: "a" }] },
      truncated: true,
      hint: "next",
      ...(ctx.forView ? { view: VIEW_MODEL } : {}),
    }),
  };
}

const registry = buildRegistry(
  [...buildRequestRegistry({ focusedConsole: true }).values()].map(stubbed),
);
const catalog = buildMcpAppCatalog(VIEWS, new Set(["whoami", ...registry.keys()]));

async function callTool(flagOn: boolean, name: string, clientRendersViews = true) {
  const server = createRatelMcpServer({
    auth,
    registry,
    describeCaller: async () => ({ projectId: PROJECT }),
    ...(flagOn ? { apps: catalog, clientRendersViews } : {}),
  });
  const transport = new SingleMessageTransport();
  await server.connect(transport);
  const [response] = (await transport.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: {} },
  } as JSONRPCMessage)) as unknown as Array<{
    result: {
      content: Array<{ type: string; text: string }>;
      structuredContent: unknown;
      _meta?: Record<string, unknown>;
    };
  }>;
  await server.close();
  return response.result;
}

test("every published view binds at least one tool", () => {
  assert.ok(BOUND.length >= 20, `${BOUND.length} bound tools`);
  for (const tool of ["get_trace", "get_session", "get_trace_conversation", "get_run_summary"])
    assert.ok(BOUND.includes(tool), tool);
});

for (const tool of BOUND) {
  test(`${tool}: content and structuredContent are byte-identical flag on and off; the view rides in _meta`, async () => {
    const off = await callTool(false, tool);
    const on = await callTool(true, tool);

    const title = VIEWS.find((view) => view.bindings.some((binding) => binding.tool === tool))!
      .title!;
    assert.equal(off.content.length, 1);
    assert.equal(
      JSON.stringify(on.content[0]),
      JSON.stringify(off.content[0]),
      "the data block is byte-identical",
    );
    assert.deepEqual(
      on.content.slice(1),
      [{ type: "text", text: viewHint(title) }],
      "flag on, a client that shows views: one line after it",
    );
    const plain = await callTool(true, tool, false);
    assert.equal(
      JSON.stringify(plain.content),
      JSON.stringify(off.content),
      "flag on, a client without views: main's content",
    );
    assert.equal(JSON.stringify(on.structuredContent), JSON.stringify(off.structuredContent));
    assert.ok(
      !JSON.stringify([on.content, on.structuredContent]).includes("session_chat"),
      "the view model is not in what the model reads",
    );

    assert.equal(off._meta, undefined, "flag off: no _meta on the result");
    assert.equal((on._meta?.[BINDING_META_KEY] as { tool?: string } | undefined)?.tool, tool);
    if (tool !== "whoami") assert.deepEqual(on._meta?.[VIEW_META_KEY], VIEW_MODEL);
  });
}

test("flag on, a client that does not show views: no view read and no view payload, only the binding", async () => {
  for (const tool of BOUND.filter((id) => id !== "whoami")) {
    const plain = await callTool(true, tool, false);
    assert.equal(
      plain._meta?.[VIEW_META_KEY],
      undefined,
      `${tool}: forView only for a client that shows views`,
    );
    assert.equal((plain._meta?.[BINDING_META_KEY] as { tool?: string } | undefined)?.tool, tool);
  }
});

test("an unbound tool never renders for a view, so it gets no view either way", async () => {
  const unbound = [...registry.keys()].find(
    (id) => !BOUND.includes(id) && !registry.get(id)!.appOnly,
  )!;
  const on = await callTool(true, unbound);
  assert.equal(on._meta, undefined);
  assert.equal(on.content.length, 1, "no view hint");
  assert.equal(
    JSON.stringify(on.structuredContent),
    JSON.stringify(await callTool(false, unbound).then((r) => r.structuredContent)),
  );
});

test("the view hint is one host-neutral line naming the view", () => {
  for (const view of VIEWS) {
    assert.ok(view.title, `${view.view} has a title`);
    const hint = viewHint(view.title!);
    assert.ok(!hint.includes("\n") && hint.length < 220, hint);
    assert.match(hint, new RegExp(`looking at this result as Ratel's ${view.title} view`));
    assert.doesNotMatch(hint, /Claude|ChatGPT|Desktop|where the client/i);
  }
});
