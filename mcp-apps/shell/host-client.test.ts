import assert from "node:assert/strict";
import { test } from "node:test";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { APP_CAPABILITIES, isMethodNotFound, toolCallFailure } from "./host-adapt";
import { type Channel, HostClient } from "./host-client";
import { errorResult, okResult } from "./types";

/**
 * HostClient against ext-apps' own host, AppBridge, over an in-memory pair:
 * the conformance check that lets views skip ext-apps' runtime (and its zod).
 */
function pair(): { channel: Channel; transport: Transport } {
  const viewListeners = new Set<(data: unknown) => void>();
  const transport: Transport = {
    start: async () => undefined,
    close: async () => undefined,
    send: async (message: JSONRPCMessage) => {
      // Cloned, as postMessage does.
      const copy = structuredClone(message);
      queueMicrotask(() => viewListeners.forEach((listener) => listener(copy)));
    },
  };
  const channel: Channel = {
    post: (message) => {
      const copy = structuredClone(message) as JSONRPCMessage;
      queueMicrotask(() => transport.onmessage?.(copy));
    },
    listen: (handler) => {
      viewListeners.add(handler);
      return () => viewListeners.delete(handler);
    },
  };
  return { channel, transport };
}

async function connected(
  hostContext: Record<string, unknown> = {
    theme: "light",
    toolInfo: { tool: { name: "list_traces", inputSchema: { type: "object" } } },
  },
) {
  const { channel, transport } = pair();
  const bridge = new AppBridge(
    null,
    { name: "test-host", version: "1.0.0" },
    { openLinks: {}, serverTools: {}, message: { text: {} }, updateModelContext: { text: {} } },
    { hostContext },
  );
  const initialized = new Promise<void>((resolve) => {
    bridge.oninitialized = () => resolve();
  });
  await bridge.connect(transport);
  const client = new HostClient(channel, { name: "ratel-test", version: "0.0.0" }, 2000);
  const result = await client.connect();
  await initialized;
  return { bridge, client, result };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("initialize returns the host context, and the host hears initialized", async () => {
  const { result, client } = await connected();
  assert.equal(result.hostContext.theme, "light");
  assert.equal(result.hostContext.toolInfo?.tool.name, "list_traces");
  assert.equal(client.getHostContext()?.theme, "light");
});

test("tool input, partial input, results and cancellation reach the view", async () => {
  const { bridge, client } = await connected();
  const seen: string[] = [];
  client.ontoolinputpartial = (params) => seen.push(`partial:${JSON.stringify(params.arguments)}`);
  client.ontoolinput = (params) => seen.push(`input:${JSON.stringify(params.arguments)}`);
  client.ontoolresult = (params) =>
    seen.push(`result:${JSON.stringify(params.structuredContent)}:${params.isError === true}`);
  client.ontoolcancelled = (params) => seen.push(`cancelled:${params.reason}`);

  await bridge.sendToolInputPartial({ arguments: { project: "ac" } });
  await bridge.sendToolInput({ arguments: { project: "acme" } });
  await bridge.sendToolResult(okResult({ n: 1 }) as CallToolResult);
  await bridge.sendToolResult(errorResult("forbidden", "No.") as CallToolResult);
  await bridge.sendToolCancelled({ reason: "stopped" });
  await tick();

  assert.deepEqual(seen, [
    'partial:{"project":"ac"}',
    'input:{"project":"acme"}',
    'result:{"ok":true,"data":{"n":1}}:false',
    'result:{"ok":false,"error":"forbidden","message":"No."}:true',
    "cancelled:stopped",
  ]);
});

test("host context changes are merged and reported", async () => {
  const { bridge, client } = await connected();
  let theme: string | undefined;
  client.onhostcontextchanged = (context) => {
    theme = context.theme;
  };
  bridge.setHostContext({
    theme: "dark",
    toolInfo: { tool: { name: "list_traces", inputSchema: { type: "object" } } },
  });
  await tick();
  assert.equal(theme, "dark");
  assert.equal(client.getHostContext()?.toolInfo?.tool.name, "list_traces");
});

test("tools/call, open-link, message and model context go to the host", async () => {
  const { bridge, client } = await connected();
  const asked: string[] = [];
  bridge.oncalltool = async (params) => {
    asked.push(`call:${params.name}`);
    return okResult({ id: params.arguments?.id }) as CallToolResult;
  };
  bridge.onopenlink = async ({ url }) => {
    asked.push(`link:${url}`);
    return {};
  };
  bridge.onmessage = async (params) => {
    asked.push(`message:${params.role}`);
    return {};
  };
  bridge.onupdatemodelcontext = async () => {
    asked.push("context");
    return {};
  };

  const result = await client.callServerTool({ name: "get_trace", arguments: { id: "t1" } });
  await client.openLink({ url: "https://app.ratel.sh/projects" });
  await client.sendMessage({ role: "user", content: [{ type: "text", text: "Why?" }] });
  await client.updateModelContext({ content: [{ type: "text", text: "Looking at t1" }] });

  assert.deepEqual(result.structuredContent, { ok: true, data: { id: "t1" } });
  assert.deepEqual(asked, [
    "call:get_trace",
    "link:https://app.ratel.sh/projects",
    "message:user",
    "context",
  ]);
});

test("a host error answer rejects the request", async () => {
  const { bridge, client } = await connected();
  bridge.oncalltool = async () => {
    throw new Error("upstream failed");
  };
  await assert.rejects(client.callServerTool({ name: "get_trace" }), /upstream failed/);
});

test("the view answers ping and teardown", async () => {
  const { bridge, client } = await connected();
  let tornDown = false;
  client.onteardown = () => {
    tornDown = true;
  };
  await bridge.teardownResource({});
  assert.equal(tornDown, true);
});

test("the view declares inline and fullscreen, so hosts that read it offer fullscreen", async () => {
  const { channel, transport } = pair();
  const bridge = new AppBridge(
    null,
    { name: "test-host", version: "1.0.0" },
    {},
    { hostContext: {} },
  );
  await bridge.connect(transport);
  const client = new HostClient(
    channel,
    { name: "ratel-test", version: "0.0.0" },
    2000,
    APP_CAPABILITIES,
  );
  await client.connect();
  assert.deepEqual(bridge.getAppCapabilities()?.availableDisplayModes, ["inline", "fullscreen"]);
});

test("a host that does not handle tools/call or open-link reads as unsupported, not as a failure", async () => {
  const { channel, transport } = pair();
  // A host with no tools/call and no open-link handler, as some hosts ship.
  const bridge = new AppBridge(
    null,
    { name: "bare-host", version: "1.0.0" },
    {},
    { hostContext: {} },
  );
  await bridge.connect(transport);
  const client = new HostClient(channel, { name: "ratel-test", version: "0.0.0" }, 2000);
  await client.connect();

  const call = await client.callServerTool({ name: "get_trace" }).then(
    () => null,
    (cause: unknown) => cause,
  );
  assert.equal(toolCallFailure(call).code, "host_unsupported");
  const link = await client.openLink({ url: "https://app.ratel.sh" }).then(
    () => null,
    (cause: unknown) => cause,
  );
  assert.equal(isMethodNotFound(link), true);
});
