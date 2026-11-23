import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { resetConfigForTests } from "@/config";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import { agentsOperations, defaultAgentsDeps } from "./agents";
import { defaultMcpServersDeps, mcpServersOperations } from "./mcp-servers";

/**
 * Owned (ADR-0004), no upstream counterpart: the default gate of the Agents and MCP servers tools
 * is the core's `agentsPages` switch (`featureEnabled`), in place of upstream's
 * `cloud-project-entities` flag service. Off, each tool refuses as forbidden and reads nothing.
 */

const PROJECT = "11111111-1111-4111-8111-111111111111";
const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};
const SAVED = {
  file: process.env.CONFIG_PATH,
  all: process.env.RATEL_EXPERIMENTAL_FEATURES,
};
/** The `agentsPages` flag on, through a config file (`web/src/config.ts`). */
const FLAG_ON = path.join(mkdtempSync(path.join(tmpdir(), "entities-gate-")), "on.json");
writeFileSync(FLAG_ON, JSON.stringify({ flags: { agentsPages: true } }));

afterEach(() => {
  restore("CONFIG_PATH", SAVED.file);
  restore("RATEL_EXPERIMENTAL_FEATURES", SAVED.all);
  resetConfigForTests();
});

function registry(reads: string[]) {
  const read = (name: string) => async () => {
    reads.push(name);
    return null;
  };
  return buildRegistry([
    ...agentsOperations({
      ...defaultAgentsDeps,
      listAgents: async () => {
        reads.push("listAgents");
        return { agents: [], environments: [] };
      },
      listHandoffs: async () => {
        reads.push("listHandoffs");
        return [];
      },
      getAgent: read("getAgent"),
    }),
    ...mcpServersOperations({
      ...defaultMcpServersDeps,
      listMcpServers: async () => {
        reads.push("listMcpServers");
        return { servers: [], environments: [] };
      },
      getMcpServer: read("getMcpServer"),
    }),
  ]);
}

const CALLS = [
  ["list_agents", {}],
  ["get_agent", { agent: "researcher" }],
  ["list_mcp_servers", {}],
  ["get_mcp_server", { server: "docs-mcp" }],
] as const;

test("with agentsPages off, every Agents and MCP servers tool refuses as forbidden", async () => {
  delete process.env.CONFIG_PATH;
  delete process.env.RATEL_EXPERIMENTAL_FEATURES;
  resetConfigForTests();
  const reads: string[] = [];
  for (const [id, params] of CALLS) {
    const result = await dispatchOperation(id, params, { registry: registry(reads), auth });
    assert.equal(result.ok === false && result.error, "forbidden", id);
    assert.equal(result.ok === false && result.reason, "project_entities_off", id);
  }
  assert.deepEqual(reads, [], "nothing is read with the switch off");
});

test("with agentsPages on, the tools read", async () => {
  process.env.CONFIG_PATH = FLAG_ON;
  resetConfigForTests();
  const reads: string[] = [];
  for (const [id, params] of CALLS) {
    const result = await dispatchOperation(id, params, { registry: registry(reads), auth });
    const expected = id.startsWith("get_") ? "not_found" : undefined;
    assert.equal(result.ok ? undefined : result.error, expected, id);
  }
  assert.deepEqual(reads, [
    "listAgents",
    "listHandoffs",
    "getAgent",
    "listMcpServers",
    "getMcpServer",
  ]);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
