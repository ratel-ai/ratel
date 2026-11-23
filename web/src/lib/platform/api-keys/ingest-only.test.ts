import assert from "node:assert/strict";
import { test } from "node:test";
import { type CatalogHandlerDeps, handleCatalogRequest } from "@/lib/catalog/pull-route-handler";
import {
  type CatalogV2HandlerDeps,
  handleCatalogV2Request,
} from "@/lib/catalog/pull-route-handler-v2";
import { handleCatalogSnapshotRequest } from "@/lib/ingest/catalogs/snapshot-handler";
import { handleRuntimeCatalogOverridesGet } from "@/lib/ingest/runtime-catalog/overrides-get-handler";
import { authenticateMcpRequest, type McpAuthDeps } from "@/lib/mcp/auth";
import { mayReadContent } from "@/lib/mcp/operations/content-access";
import { createMcpRouteHandler } from "@/lib/mcp/route-handler";
import { type ResolveProjectDeps, resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import { generateApiKey } from "@/lib/platform/api-keys";
import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { type ApiKeyScope, INGEST_SCOPES, presetScopes } from "@/lib/platform/api-keys/scopes";
import { createTokenBucketRateLimiter } from "@/lib/platform/rate-limit";
import { handleIntentGraphGet } from "@/lib/readings/intent-graph/get-handler";
import { handleIntentGraphPut } from "@/lib/readings/intent-graph/put-handler";

/**
 * RC-585's headline promise, proven against the real handlers: an ingest-only
 * key (the kind that ships inside an app, so anyone may hold it) can add data
 * to its project and do nothing else. Catalog, skills, jobs, runtime catalog,
 * intent graph, embeddings, Tool Picker, MCP and captured content all refuse
 * it with 403, before any of them reads or spends anything.
 *
 * Owned (ADR-0004): the embeddings proxy and the Tool Picker are the edition's
 * (ratel-platform), which proves their refusal itself.
 */

const PROJECT = "11111111-1111-4111-8111-111111111111";
const INGEST_KEY = generateApiKey("publishable");

const ingestRow = {
  id: "key-ingest",
  projectId: PROJECT,
  keyPrefix: INGEST_KEY.prefix,
  scopes: [...presetScopes("ingest")] as string[],
  rateLimitPerMinute: null,
};

/** A key store holding only the ingest-only key. Anything past auth is a failure. */
const keyStore = {
  isDbConfigured: () => true,
  hashApiKey: (plaintext: string) => (plaintext === INGEST_KEY.plaintext ? "ingest-hash" : "other"),
  findActiveApiKeyByHash: async (hash: string) => (hash === "ingest-hash" ? ingestRow : null),
};

const touched: string[] = [];
const resolverDeps: ResolveProjectDeps = {
  ...keyStore,
  touchApiKey: async (id) => {
    touched.push(id);
  },
};

/** The real resolver, on the fake key store. */
const resolve: typeof resolveProjectFromBearer = (request, scope) =>
  resolveProjectFromBearer(request, scope, resolverDeps);

/**
 * Handler deps holding only what auth needs. Any other dependency a handler
 * reaches for throws, so a handler that went past auth fails the test.
 */
function guarded<T>(base: Record<string, unknown>): T {
  return new Proxy(base, {
    get(target, property) {
      if (property in target) return target[property as string];
      if (typeof property !== "string" || property === "then") return undefined;
      return () => {
        throw new Error(`a refused key reached ${property}`);
      };
    },
  }) as T;
}

function request(path: string, method = "GET"): Request {
  return new Request(`https://cloud.ratel.sh${path}`, {
    method,
    headers: {
      authorization: `Bearer ${INGEST_KEY.plaintext}`,
      "content-type": "application/json",
    },
    ...(method === "GET" ? {} : { body: "{}" }),
  });
}

async function assertForbidden(response: Response, label: string): Promise<void> {
  assert.equal(response.status, 403, `${label} answered ${response.status}`);
  const text = await response.text();
  assert.match(text, /permission|MCP/i, `${label} gives a plain reason`);
}

test("the resolver refuses an ingest-only key on every non-ingest route, and admits it on ingest", async () => {
  for (const [route, scope] of Object.entries(BEARER_ROUTE_SCOPES) as Array<
    [string, ApiKeyScope]
  >) {
    const [method, path] = route.split(" ");
    const resolved = await resolve(request(path, method), scope);
    if (INGEST_SCOPES.includes(scope)) {
      assert.ok(resolved.ok, `${route} admits it`);
      assert.equal(
        resolved.ok && resolved.policy.publishable,
        true,
        `${route} marks it publishable`,
      );
    } else {
      assert.ok(!resolved.ok, `${route} refuses it`);
      const body = await resolved.response.clone().json();
      assert.equal(resolved.response.status, 403, route);
      assert.equal(body.reason, "missing_scope", route);
      assert.equal(body.scope, scope, route);
    }
  }
});

test("a refused key is not stamped as used", async () => {
  touched.length = 0;
  await resolve(request("/api/v1/skills"), "skills:read");
  assert.deepEqual(touched, []);
});

test("catalog pull (v1 and v2) refuses it", async () => {
  await assertForbidden(
    await handleCatalogRequest(
      request("/v1/catalog"),
      guarded<CatalogHandlerDeps>({
        ...keyStore,
        scope: BEARER_ROUTE_SCOPES["GET /api/v1/catalog"],
      }),
    ),
    "GET /v1/catalog",
  );
  await assertForbidden(
    await handleCatalogV2Request(
      request("/v2/catalog"),
      guarded<CatalogV2HandlerDeps>({
        ...keyStore,
        scope: BEARER_ROUTE_SCOPES["GET /api/v2/catalog"],
      }),
    ),
    "GET /v2/catalog",
  );
});

test("catalog sync, runtime overrides and the intent graph refuse it", async () => {
  const limiter = createTokenBucketRateLimiter({ limitPerMinute: 100, burst: 100 });
  await assertForbidden(
    await handleCatalogSnapshotRequest(
      request("/api/v1/catalog/snapshot", "PUT"),
      guarded({
        scope: BEARER_ROUTE_SCOPES["PUT /api/v1/catalog/snapshot"],
        resolveProjectFromBearer: resolve,
        rateLimiter: limiter,
      }),
    ),
    "PUT /v1/catalog/snapshot",
  );
  await assertForbidden(
    await handleRuntimeCatalogOverridesGet(
      request("/v1/runtime-catalog/overrides"),
      guarded({
        scope: BEARER_ROUTE_SCOPES["GET /api/v1/runtime-catalog/overrides"],
        resolveProjectFromBearer: resolve,
      }),
    ),
    "GET /v1/runtime-catalog/overrides",
  );
  await assertForbidden(
    await handleIntentGraphGet(
      request("/v1/intent-graph?source=s"),
      guarded({
        scope: BEARER_ROUTE_SCOPES["GET /api/v1/intent-graph"],
        resolveProjectFromBearer: resolve,
        rateLimiter: limiter,
      }),
    ),
    "GET /v1/intent-graph",
  );
  await assertForbidden(
    await handleIntentGraphPut(
      request("/v1/intent-graph", "PUT"),
      guarded({
        scope: BEARER_ROUTE_SCOPES["PUT /api/v1/intent-graph"],
        resolveProjectFromBearer: resolve,
        rateLimiter: limiter,
      }),
    ),
    "PUT /v1/intent-graph",
  );
});

const mcpDeps: McpAuthDeps = {
  isDbConfigured: () => true,
  findActiveApiKeyByHash: async () => ingestRow as never,
  touchApiKey: async () => {
    throw new Error("a refused key must not be stamped");
  },
  getOrganizationByProjectId: async () => {
    throw new Error("a refused key must not load its organization");
  },
  verifyOAuthToken: async () => {
    throw new Error("an rtl_pub_ key is an API key, never an OAuth token");
  },
};

test("MCP refuses it at the door with 403, and nothing runs", async () => {
  const handler = createMcpRouteHandler({
    authenticate: (req) => authenticateMcpRequest(req, mcpDeps),
    credentialLimiter: createTokenBucketRateLimiter({ limitPerMinute: 10, burst: 10 }),
    perKeyLimiter: createTokenBucketRateLimiter({ limitPerMinute: 10, burst: 10 }),
    globalLimiter: createTokenBucketRateLimiter({ limitPerMinute: 10, burst: 10 }),
    trackServerEvent: async () => {},
    launchAccess: async () => {
      throw new Error("a refused key must not reach launch access");
    },
  });
  const response = await handler(
    new Request("https://cloud.ratel.sh/api/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${INGEST_KEY.plaintext}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  await assertForbidden(response, "POST /api/mcp");
});

test("captured content is withheld from it even with content reading on", async () => {
  const auth = {
    kind: "api-key" as const,
    projectId: PROJECT,
    apiKeyId: ingestRow.id,
    scopes: ingestRow.scopes,
    organization: null,
  };
  assert.equal(
    await mayReadContent({ auth, projectId: PROJECT }, { contentOptIn: async () => true }),
    false,
  );
});
