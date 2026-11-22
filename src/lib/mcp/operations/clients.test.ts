import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import type { ClientsOverview, ClientsWindow } from "@/lib/views/clients/queries";
import { type ClientsOperationDeps, clientsOperations } from "./clients";

/** The Clients tab over MCP (RC-778): the tab's read, with no raw IP. */

const PROJECT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-17T12:00:00.000Z");
const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};
const AT = new Date("2026-11-16T09:00:00.000Z");
const OVERVIEW: ClientsOverview = {
  harnesses: [
    {
      harness: "claude-code",
      calls: 4,
      errors: 1,
      errorRate: 0.25,
      sessions: 2,
      firstSeenAt: AT,
      lastSeenAt: AT,
      detection: null,
    },
    {
      harness: null,
      calls: 2,
      errors: 0,
      errorRate: 0,
      sessions: 2,
      firstSeenAt: AT,
      lastSeenAt: AT,
      detection: null,
    },
  ],
  versions: [
    {
      harness: "claude-code",
      version: "2.1.3",
      calls: 4,
      errors: 1,
      errorRate: 0.25,
      sessions: 2,
      firstSeenAt: AT,
      lastSeenAt: AT,
      detection: null,
    },
  ],
  countries: [{ country: "GB", calls: 4, sessions: 2 }],
  transports: [{ value: "http", calls: 4 }],
  protocolVersions: [{ value: "2025-11-25", calls: 6 }],
  servers: ["weather-mcp"],
  environments: ["prod"],
};

function harness(overrides: Partial<ClientsOperationDeps> = {}) {
  const windows: ClientsWindow[] = [];
  const deps: ClientsOperationDeps = {
    getClientsOverview: async (_projectId, window) => (windows.push(window), OVERVIEW),
    now: () => NOW,
    ...overrides,
  };
  const run = (params: unknown) =>
    dispatchOperation("list_clients", params, {
      registry: buildRegistry(clientsOperations(deps)),
      auth,
    });
  return { run, windows };
}

test("list_clients returns the harnesses, versions, countries and splits, with the unknown-client hint", async () => {
  const { run, windows } = harness();
  const result = await run({ server: "weather-mcp", environment: "prod" });
  assert.ok(result.ok, JSON.stringify(result));
  const data = result.data as Record<string, unknown>;
  assert.deepEqual(data.harnesses, [
    {
      harness: "claude-code",
      calls: 4,
      errors: 1,
      errorRate: 0.25,
      sessions: 2,
      firstSeenAt: AT.toISOString(),
      lastSeenAt: AT.toISOString(),
    },
    {
      harness: null,
      calls: 2,
      errors: 0,
      errorRate: 0,
      sessions: 2,
      firstSeenAt: AT.toISOString(),
      lastSeenAt: AT.toISOString(),
    },
  ]);
  assert.deepEqual(data.countries, [{ country: "GB", calls: 4, sessions: 2 }]);
  assert.equal(data.href, `/project/${PROJECT}/mcp?tab=clients&server=weather-mcp`);
  assert.match(String((result as { hint?: string }).hint), /unknown client/);
  assert.deepEqual(windows, [
    {
      since: new Date("2026-10-18T12:00:00.000Z"),
      until: NOW,
      server: "weather-mcp",
      environment: "prod",
    },
  ]);
  assert.equal(/client_?ip|clientIp/i.test(JSON.stringify(result)), false);
});
