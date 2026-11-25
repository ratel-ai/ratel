import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { assembleOperations } from "@/lib/mcp/operations";
import {
  BEARER_ROUTE_SCOPES,
  INTERNAL_KEY_LOOKUP_ROUTE,
  MCP_ROUTE,
  mcpOperationScope,
} from "@/lib/platform/api-keys/routes";
import { API_KEY_SCOPES } from "@/lib/platform/api-keys/scopes";

/**
 * The guard that keeps every bearer route scoped (RC-585).
 *
 * It reads the source rather than trusting a list someone has to remember: a
 * route that authenticates with a project API key, directly or through a
 * handler that does, must appear in `BEARER_ROUTE_SCOPES` and must pass its own
 * entry for every method it exports. A new bearer route that skips the check
 * fails here before it can ship.
 */

const WEB_ROOT = join(import.meta.dirname, "..", "..", "..");
const API_ROOT = join(WEB_ROOT, "app", "api");
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

function walk(dir: string, match: (file: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : walk(path, match);
    return match(path) ? [path] : [];
  });
}

function posix(path: string): string {
  return path.split(sep).join("/");
}

function routePath(file: string): string {
  return `/${posix(relative(join(WEB_ROOT, "app"), file)).replace(/\/route\.ts$/, "")}`;
}

function exportedMethods(source: string): string[] {
  return METHODS.filter((method) =>
    new RegExp(`export\\s+(const|async\\s+function|function)\\s+${method}\\b`).test(source),
  );
}

const routeFiles = walk(API_ROOT, (file) => file.endsWith(`${sep}route.ts`)).map((file) => ({
  file,
  path: routePath(file),
  source: readFileSync(file, "utf8"),
}));

const libSources = walk(
  join(WEB_ROOT, "lib"),
  (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
).map((file) => ({ file: posix(relative(WEB_ROOT, file)), source: readFileSync(file, "utf8") }));

/**
 * Lib modules that authenticate a key for a request. MCP is declared per tool
 * instead, so its modules are left out and checked below on their own.
 */
const AUTHENTICATING_MODULES = libSources
  .filter(
    ({ file }) =>
      !file.startsWith("lib/platform/api-keys/") &&
      file !== "lib/platform/api-key-bearer.ts" &&
      !file.startsWith("lib/mcp/"),
  )
  .filter(({ source }) => /\bauthenticateApiKey\(|\bresolveProjectFromBearer\(/.test(source))
  .map(({ file }) => `@/${file.replace(/\.ts$/, "")}`);

const DIRECT_MARKERS =
  /\bresolveProjectFromBearer\b|\bauthenticateApiKey\b|\bfindActiveApiKeyByHash\b|\bhashApiKey\b|\btoolPickerRouteDeps\b/;

function authenticatesWithKey(source: string): boolean {
  if (DIRECT_MARKERS.test(source)) return true;
  return AUTHENTICATING_MODULES.some((specifier) => source.includes(`"${specifier}"`));
}

test("the scan sees the handlers that authenticate keys (so the guard is not vacuous)", () => {
  for (const specifier of [
    "@/lib/ingest/otlp/route-handler",
    "@/lib/ingest/otlp/logs-route-handler",
    "@/lib/ingest/trace-events/route-handler",
    "@/lib/catalog/pull-route-handler",
  ]) {
    assert.ok(AUTHENTICATING_MODULES.includes(specifier), specifier);
  }
});

test("every route that authenticates with an API key declares a scope for every method it exports", () => {
  const declared = new Set<string>(Object.keys(BEARER_ROUTE_SCOPES));
  const missing: string[] = [];
  const unwired: string[] = [];
  for (const route of routeFiles) {
    if ([MCP_ROUTE, INTERNAL_KEY_LOOKUP_ROUTE].includes(`POST ${route.path}`)) continue;
    if (!authenticatesWithKey(route.source)) continue;
    for (const method of exportedMethods(route.source)) {
      const key = `${method} ${route.path}`;
      if (!declared.has(key)) missing.push(key);
      else if (!route.source.includes(`BEARER_ROUTE_SCOPES["${key}"]`)) unwired.push(key);
    }
  }
  assert.deepEqual(
    missing,
    [],
    "add these to BEARER_ROUTE_SCOPES in lib/platform/api-keys/routes.ts",
  );
  assert.deepEqual(unwired, [], "pass BEARER_ROUTE_SCOPES[route] where these routes authenticate");
});

/**
 * The routes the edition serves (app/(ee), from ratel-platform): declared in the shared table so
 * a key's scopes mean the same in both editions, with no route file in this repository to scan.
 */
const EDITION_ROUTES = new Set([
  "POST /api/v1/embeddings",
  "POST /api/v1/pick",
  "POST /api/v1/tools/pick",
]);

test("every declared route exists, exports its method, and names only its own entry", () => {
  for (const key of Object.keys(BEARER_ROUTE_SCOPES)) {
    if (EDITION_ROUTES.has(key)) continue;
    const [method, path] = key.split(" ");
    const route = routeFiles.find((candidate) => candidate.path === path);
    assert.ok(route, `${key}: no app${path}/route.ts`);
    assert.ok(
      exportedMethods(route.source).includes(method),
      `${key}: route does not export ${method}`,
    );
  }
  for (const route of routeFiles) {
    for (const [, key] of route.source.matchAll(/BEARER_ROUTE_SCOPES\["([^"]+)"\]/g)) {
      assert.equal(
        key.split(" ")[1],
        route.path,
        `${route.path} passes another route's scope (${key})`,
      );
    }
  }
});

test("only the shared resolver looks a key up, so no route can authenticate around it", () => {
  const allowed = new Set([
    "lib/platform/projects/queries.ts",
    "lib/platform/api-keys/authenticate.ts",
    "lib/platform/api-key-bearer.ts",
    "lib/mcp/auth.ts",
    // The Site Copilot seed hands the real traces handler its own key store; upstream keeps its
    // seeds under scripts/, outside the scan.
    "lib/console/seed/site-copilot-seed.ts",
    // A gateway's lookup: the shared value is checked before any key is read.
    "lib/platform/internal-auth/key-resolve.ts",
    "app/api/internal/keys/resolve/route.ts",
  ]);
  const offenders = [
    ...libSources,
    ...routeFiles.map((route) => ({
      file: posix(relative(WEB_ROOT, route.file)),
      source: route.source,
    })),
  ]
    .filter(({ file, source }) => !allowed.has(file) && /findActiveApiKeyByHash\(/.test(source))
    .map(({ file }) => file);
  assert.deepEqual(offenders, [], "use authenticateApiKey or resolveProjectFromBearer instead");
});

test("the internal key lookup refuses an unproven caller before it looks a key up", () => {
  const file = join(WEB_ROOT, "lib", "platform", "internal-auth", "key-resolve.ts");
  const source = readFileSync(file, "utf8");
  const body = source.slice(source.indexOf("export async function handleKeyResolve"));
  assert.ok(body.indexOf("refuseInternalRequest(") > 0);
  assert.ok(body.indexOf("refuseInternalRequest(") < body.indexOf("findActiveApiKeyByHash("));
});

test("MCP: the route exists and every tool needs a declared MCP scope", () => {
  const [method, path] = MCP_ROUTE.split(" ");
  const route = routeFiles.find((candidate) => candidate.path === path);
  assert.ok(route && exportedMethods(route.source).includes(method));
  const operations = assembleOperations({ focusedConsole: true });
  assert.ok(operations.length > 0);
  for (const operation of operations) {
    const scope = mcpOperationScope(operation);
    assert.ok(scope === (operation.mutates ? "mcp:write" : "mcp:read"), operation.id);
  }
});

test("every declared scope is a known scope", () => {
  for (const [route, scope] of Object.entries(BEARER_ROUTE_SCOPES)) {
    assert.ok((API_KEY_SCOPES as readonly string[]).includes(scope), route);
  }
});
