import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { isValidElement } from "react";
import { resetConfigForTests } from "@/config";
import AgentDetailPage from "./agents/[agent]/page";
import AgentsPage from "./agents/page";
import McpServerPage from "./mcp/[server]/page";
import McpServersPage from "./mcp/page";

/**
 * RP-83: `agentsPages` decides first. Off, the four pages are absent (404) even when no
 * database is configured; on, a deployment without a database gets the setup notice.
 */

const SWITCHES = ["CONFIG_PATH", "RATEL_EXPERIMENTAL_FEATURES", "DATABASE_URL"] as const;
const dir = mkdtempSync(path.join(tmpdir(), "entity-pages-"));
/** The `agentsPages` flag on, through a config file (`web/src/config.ts`). */
const flagOn = path.join(dir, "agents-pages.json");
writeFileSync(flagOn, JSON.stringify({ flags: { agentsPages: true } }));
const saved: Record<string, string | undefined> = {};
const is404 = (err: { digest?: string }) => String(err.digest).includes("404");

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
  resetConfigForTests();
});

after(() => {
  for (const name of SWITCHES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  resetConfigForTests();
  rmSync(dir, { recursive: true, force: true });
});

for (const [name, render] of PAGES) {
  test(`${name}: flag off and no database, the page is not found`, async () => {
    await assert.rejects(render(), is404);
  });

  test(`${name}: flag on and no database, the page shows the setup notice`, async () => {
    process.env.CONFIG_PATH = flagOn;
    resetConfigForTests();
    try {
      assert.ok(isValidElement(await render()));
    } finally {
      delete process.env.CONFIG_PATH;
      resetConfigForTests();
    }
  });
}

function project() {
  return Promise.resolve({ projectId: "p1" });
}

function none() {
  return Promise.resolve({});
}
