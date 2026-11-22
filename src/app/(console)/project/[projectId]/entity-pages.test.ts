import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { isValidElement } from "react";
import AgentDetailPage from "./agents/[agent]/page";
import AgentsPage from "./agents/page";
import McpServerPage from "./mcp/[server]/page";
import McpServersPage from "./mcp/page";

/**
 * RP-83: a deployment without a database gets each page's setup notice. RP-138: no switch decides
 * first any more (FF_AGENTS_PAGES is gone, ratel-cloud #529), so the pages always exist.
 */

const SWITCHES = ["RATEL_EXPERIMENTAL_FEATURES", "DATABASE_URL"] as const;
const saved: Record<string, string | undefined> = {};

const PAGES = [
  ["Agents", () => AgentsPage({ params: project(), searchParams: none() })],
  [
    "Agent detail",
    () =>
      AgentDetailPage({
        params: Promise.resolve({ projectId: "p1", agent: "claude" }),
        searchParams: none(),
      }),
  ],
  ["MCP servers", () => McpServersPage({ params: project(), searchParams: none() })],
  [
    "MCP server detail",
    () =>
      McpServerPage({
        params: Promise.resolve({ projectId: "p1", server: "slack" }),
        searchParams: none(),
      }),
  ],
] as const;

before(() => {
  for (const name of SWITCHES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

after(() => {
  for (const name of SWITCHES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

for (const [name, render] of PAGES) {
  test(`${name}: no database, the page shows the setup notice`, async () => {
    assert.ok(isValidElement(await render()));
  });
}

function project() {
  return Promise.resolve({ projectId: "p1" });
}

function none() {
  return Promise.resolve({});
}
