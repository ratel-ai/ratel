import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import { agentsOperations, defaultAgentsDeps } from "./agents";
import { clientsOperations, defaultClientsDeps } from "./clients";
import { defaultMcpServersDeps, mcpServersOperations } from "./mcp-servers";

/**
 * Owned (ADR-0030), no upstream counterpart: the default gate of the Agents and MCP servers tools,
 * and of the Clients tab's `list_clients` (RC-778, RP-138), is the core's `FF_AGENTS_PAGES` switch (`featureEnabled`), in place of upstream's
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
  flag: process.env.FF_AGENTS_PAGES,
  all: process.env.RATEL_EXPERIMENTAL_FEATURES,
};

afterEach(() => {
  restore("FF_AGENTS_PAGES", SAVED.flag);
  restore("RATEL_EXPERIMENTAL_FEATURES", SAVED.all);
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
    ...clientsOperations({
      ...defaultClientsDeps,
      getClientsOverview: async () => {
        reads.push("getClientsOverview");
        return {
          harnesses: [],
          versions: [],
          countries: [],
          transports: [],
          protocolVersions: [],
          servers: [],
          environments: [],
        };
      },
    }),
  ]);
}

const CALLS = [
  ["list_agents", {}],
  ["get_agent", { agent: "researcher" }],
  ["list_mcp_servers", {}],
  ["get_mcp_server", { server: "docs-mcp" }],
  ["list_clients", {}],
] as const;

test("with FF_AGENTS_PAGES off, every Agents and MCP servers tool refuses as forbidden", async () => {
  delete process.env.FF_AGENTS_PAGES;
  delete process.env.RATEL_EXPERIMENTAL_FEATURES;
  const reads: string[] = [];
  for (const [id, params] of CALLS) {
    const result = await dispatchOperation(id, params, { registry: registry(reads), auth });
    assert.equal(result.ok === false && result.error, "forbidden", id);
    assert.equal(result.ok === false && result.reason, "project_entities_off", id);
  }
  assert.deepEqual(reads, [], "nothing is read with the switch off");
});

test("with FF_AGENTS_PAGES on, the tools read", async () => {
  process.env.FF_AGENTS_PAGES = "1";
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
    "getClientsOverview",
  ]);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
