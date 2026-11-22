import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { McpAuthContext } from "./auth";
import { agentToolCount, assembleOperations } from "./operations";
import { buildRegistry, type McpOperation, type OperationContext } from "./registry";
import { createRatelMcpServer } from "./server";
import { SingleMessageTransport } from "./transport";

/**
 * Flag off, over the whole registry (RW-37): every operation the server
 * registers is called with `FF_MCP_APPS` off (no catalog), and each one
 * runs without `forView` and comes back exactly as main's server returned it.
 *
 * The operations' own code with `forView` unset was compared against main on
 * a seeded database before the merge (RW-37); this pins the server's half
 * without a database: what each tool is handed and how its answer is
 * serialized. Main's asToolResult, copied here as main has it:
 * `{ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError? }`.
 */
function mainToolResult(payload: unknown, isError: boolean) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

const PROJECT = "11111111-1111-4111-8111-111111111111";
const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

/** Each real operation, its execute swapped for one that records its context and answers with a view too. */
function spiedRegistry() {
  const seen = new Map<string, OperationContext>();
  const operations = assembleOperations().map(
    (operation): McpOperation => ({
      ...operation,
      async execute(ctx) {
        seen.set(operation.id, ctx);
        return {
          data: { id: operation.id, rows: [1, 2] },
          hint: "next",
          view: { kind: "never_without_a_view" },
        };
      },
    }),
  );
  return { registry: buildRegistry(operations), operations, seen };
}

async function send(server: ReturnType<typeof createRatelMcpServer>, message: JSONRPCMessage) {
  const transport = new SingleMessageTransport();
  await server.connect(transport);
  try {
    return await transport.handle(message);
  } finally {
    await server.close();
  }
}

test("flag off: every registered tool runs without forView and answers exactly as on main", async () => {
  const { registry, operations, seen } = spiedRegistry();
  const make = () =>
    createRatelMcpServer({ auth, registry, describeCaller: async () => ({ projectId: PROJECT }) });

  const listed = (
    await send(make(), { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  )[0] as unknown as { result: { tools: { name: string; _meta?: Record<string, unknown> }[] } };
  const names = new Set(listed.result.tools.map((tool) => tool.name));
  const appOnly = operations
    .filter((operation) => operation.appOnly)
    .map((operation) => operation.id);
  assert.ok(appOnly.includes("get_session_step_content"));
  for (const id of appOnly)
    assert.equal(names.has(id), false, `${id} is app-only: absent with the flag off`);
  for (const tool of listed.result.tools)
    assert.equal(tool._meta?.ui, undefined, `${tool.name} carries no ui _meta`);

  const callable = operations.filter((operation) => !operation.appOnly);
  assert.equal(
    names.size,
    callable.length + 1,
    "every operation but the app-only ones, and whoami",
  );
  for (const operation of callable) {
    const [reply] = await send(make(), {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: operation.id, arguments: { projectId: PROJECT } },
    });
    const result = (reply as unknown as { result: Record<string, unknown> }).result;
    if (result.isError) {
      // Its params need more than a project: refused before it ran, by the SDK's input check
      // (its own text, no structuredContent) or by dispatch (serialized as on main).
      assert.equal(seen.has(operation.id), false);
      assert.equal(result._meta, undefined);
      if (result.structuredContent !== undefined)
        assert.deepEqual(
          result,
          mainToolResult(result.structuredContent, true),
          `${operation.id}: refusal as main serializes it`,
        );
      continue;
    }
    assert.equal(
      seen.get(operation.id)?.forView,
      undefined,
      `${operation.id}: no forView with the flag off`,
    );
    const payload = {
      ok: true,
      operation_id: operation.id,
      data: { id: operation.id, rows: [1, 2] },
      hint: "next",
    };
    assert.deepEqual(
      result,
      mainToolResult(payload, false),
      `${operation.id}: no view data, no _meta, the text main wrote`,
    );
  }
  assert.ok(
    seen.size > callable.length / 2,
    `most tools ran with just a project (${seen.size} of ${callable.length})`,
  );
});

test("the Integrations page's tool count is the flag-off tools/list, as main's", async () => {
  const { registry } = spiedRegistry();
  const server = createRatelMcpServer({
    auth,
    registry,
    describeCaller: async () => ({ projectId: PROJECT }),
  });
  const listed = (
    await send(server, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  )[0] as unknown as { result: { tools: unknown[] } };
  assert.equal(agentToolCount(), listed.result.tools.length);
  const pinned = JSON.parse(
    readFileSync(new URL("./__fixtures__/tools-list.json", import.meta.url), "utf8"),
  ) as unknown[];
  assert.equal(agentToolCount(), pinned.length, "main's tools-list.json");
});
