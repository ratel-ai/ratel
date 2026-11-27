import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resetConfigForTests } from "@/config";

/**
 * The guard of everything under /api/internal. An edition's sign-in proxy lets the whole prefix
 * through, so each route must refuse a caller without the shared secret by itself. The routes are
 * found on disk and called, so a new one is covered, and fails here, before it can be opened.
 */
const ROOT = import.meta.dirname;
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
const VALUE = "s".repeat(44);

type Handler = (request: Request, context: unknown) => Promise<Response>;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return /^route\.tsx?$/.test(name) ? [path] : [];
  });
}

function configure(secret: string | undefined): void {
  if (secret === undefined) delete process.env.RATEL_INTERNAL_SECRET;
  else process.env.RATEL_INTERNAL_SECRET = secret;
  resetConfigForTests();
}

const original = process.env.RATEL_INTERNAL_SECRET;
afterEach(() => configure(original));

const routes = await Promise.all(
  routeFiles(ROOT).map(async (file) => {
    const route: Record<string, unknown> = await import(pathToFileURL(file).href);
    return {
      path: `/api/internal/${relative(ROOT, dirname(file))}`,
      methods: METHODS.filter((method) => typeof route[method] === "function").map(
        (method) => [method, route[method] as Handler] as const,
      ),
    };
  }),
);

async function status(path: string, method: string, handler: Handler, authorization?: string) {
  const request = new Request(`https://app.test${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }),
  });
  return (await handler(request, { params: Promise.resolve({}) })).status;
}

test("the routes on disk are the ones that are known, so the guard is not vacuous", () => {
  assert.deepEqual(
    routes.flatMap(({ path, methods }) => methods.map(([method]) => `${method} ${path}`)).sort(),
    ["GET /api/internal/holds", "POST /api/internal/holds", "POST /api/internal/keys/resolve"],
  );
  for (const { path, methods } of routes) assert.ok(methods.length > 0, path);
});

test("every internal route refuses a missing or a wrong secret, and does not exist while it is unset", async () => {
  for (const { path, methods } of routes) {
    for (const [method, handler] of methods) {
      const label = `${method} ${path}`;
      configure(VALUE);
      for (const authorization of [
        undefined,
        "Bearer wrong",
        `Bearer ${VALUE}x`,
        `Bearer ${VALUE.slice(1)}`,
        `Basic ${VALUE}`,
        VALUE,
        "Bearer rtl_a_project_key",
      ]) {
        assert.equal(
          await status(path, method, handler, authorization),
          401,
          `${label}: ${authorization}`,
        );
      }
      configure(undefined);
      assert.equal(await status(path, method, handler, `Bearer ${VALUE}`), 404, `${label}: unset`);
      configure("too-short");
      assert.equal(await status(path, method, handler, "Bearer too-short"), 404, `${label}: short`);
    }
  }
});

test("with the right secret each route goes past the check (the refusals above are the check's)", async () => {
  configure(VALUE);
  for (const { path, methods } of routes) {
    for (const [method, handler] of methods) {
      const got = await status(path, method, handler, `Bearer ${VALUE}`);
      assert.ok(got !== 401 && got !== 404, `${method} ${path}: ${got}`);
    }
  }
});
