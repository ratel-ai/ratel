import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { buildMcpAppCatalog, McpAppCatalogError } from "./catalog";
import { MCP_APPS_FLAG, mcpAppsEnabled } from "./flag";
import { loadMcpAppCatalog, memoizedCatalog, readGeneratedViews } from "./load";
import type { McpAppView } from "./types";

// Owned (ADR-0004): upstream's catalog and load cases. The flag cases are the FF_MCP_APPS env
// switch's: upstream asks its flag service per caller, which this edition does not have.

const TOOLS = new Set(["whoami", "list_traces", "get_trace"]);
const view = (name: string, tools: string[]): McpAppView => ({
  view: name,
  html: "<!doctype html><html></html>",
  bindings: tools.map((tool) => ({ tool })),
});

test("a catalog indexes each bound tool to its view's ui:// URI", () => {
  const catalog = buildMcpAppCatalog(
    [view("list", ["list_traces"]), view("detail", ["get_trace"])],
    TOOLS,
  );
  assert.deepEqual(catalog.boundTool("list_traces"), {
    view: "list",
    uri: "ui://ratel/list",
    binding: { tool: "list_traces" },
  });
  assert.equal(catalog.boundTool("whoami"), undefined);
});

test("a binding to a tool the server does not register fails at load", () => {
  assert.throws(
    () =>
      loadMcpAppCatalog({ readViews: () => [view("list", ["list_tracez"])], toolIds: () => TOOLS }),
    (error: unknown) => error instanceof McpAppCatalogError && /list_tracez/.test(error.message),
  );
});

test("a tool renders in one view only", () => {
  assert.throws(
    () =>
      buildMcpAppCatalog([view("list", ["list_traces"]), view("other", ["list_traces"])], TOOLS),
    McpAppCatalogError,
  );
});

test("view names are unique slugs with HTML", () => {
  assert.throws(() => buildMcpAppCatalog([view("List", [])], TOOLS), McpAppCatalogError);
  assert.throws(
    () => buildMcpAppCatalog([view("list", []), view("list", [])], TOOLS),
    McpAppCatalogError,
  );
  assert.throws(
    () => buildMcpAppCatalog([{ ...view("list", []), html: "" }], TOOLS),
    McpAppCatalogError,
  );
});

test("an unbuilt checkout loads an empty catalog", () => {
  const catalog = loadMcpAppCatalog({ readViews: () => null, toolIds: () => TOOLS });
  assert.deepEqual(catalog.views, []);
});

const apiKey: McpAuthContext = {
  kind: "api-key",
  projectId: "p1",
  apiKeyId: "k1",
  scopes: ["*"],
  organization: null,
};
const person: McpAuthContext = {
  kind: "oauth",
  externalUserId: "user_1",
  userId: "row-1",
  memberships: [],
};

test("the flag is the FF_MCP_APPS switch, off by default", async () => {
  assert.equal(MCP_APPS_FLAG, "FF_MCP_APPS");
  assert.equal(await mcpAppsEnabled(apiKey, {}), false);
  assert.equal(await mcpAppsEnabled(apiKey, { FF_MCP_APPS: "false" }), false);
  assert.equal(
    await mcpAppsEnabled(apiKey, { FF_MCP_APPS: "yes" }),
    false,
    "only true or 1 turns it on",
  );
});

test("FF_MCP_APPS on is on for the whole deployment: a project key and a person alike", async () => {
  for (const value of ["1", "true", " TRUE "]) {
    assert.equal(await mcpAppsEnabled(apiKey, { FF_MCP_APPS: value }), true, value);
    assert.equal(await mcpAppsEnabled(person, { FF_MCP_APPS: value }), true, value);
  }
});

test("RATEL_EXPERIMENTAL_FEATURES turns it on in the open-source edition", async () => {
  assert.equal(await mcpAppsEnabled(apiKey, { RATEL_EXPERIMENTAL_FEATURES: "1" }), true);
});

test("a views.json that is missing is no views; one that is broken throws for the route handler to catch", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-views-"));
  assert.equal(readGeneratedViews(path.join(dir, "views.json")), null);
  writeFileSync(path.join(dir, "bad.json"), "{ not json");
  assert.throws(() => readGeneratedViews(path.join(dir, "bad.json")));
  writeFileSync(path.join(dir, "object.json"), "{}");
  assert.throws(() => readGeneratedViews(path.join(dir, "object.json")), /must hold an array/);
});

test("a catalog that fails to load is read and reported once, then serves no views without reading again", () => {
  let reads = 0;
  const reported: unknown[] = [];
  const catalog = memoizedCatalog(
    () => {
      reads += 1;
      throw new Error("views.json is not JSON");
    },
    (error) => reported.push(error),
  );
  for (let i = 0; i < 5; i++) assert.deepEqual(catalog().views, []);
  assert.equal(reads, 1);
  assert.equal(reported.length, 1);

  let good = 0;
  const ok = memoizedCatalog(
    () => (good++, buildMcpAppCatalog([view("list", ["list_traces"])], TOOLS)),
    () => assert.fail("no report"),
  );
  ok();
  ok();
  assert.equal(good, 1);
});
