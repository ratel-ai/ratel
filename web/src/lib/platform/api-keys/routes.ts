import type { ApiKeyScope } from "@/lib/platform/api-keys/scopes";

/**
 * Every route a project API key can reach, and the one scope it needs (RC-585).
 *
 * Route files read their scope from here (`BEARER_ROUTE_SCOPES["POST /api/v1/traces"]`),
 * so the scope a route checks and the scope this table declares cannot drift.
 * `lib/api-keys/routes.test.ts` walks `app/api/**` and fails when a route that
 * authenticates with a key is missing from this table, or does not pass its
 * entry, so a new bearer route cannot ship without declaring what it needs.
 *
 * MCP (`POST /api/mcp`) is one route with many tools, so it is declared per
 * tool instead: a tool that changes state needs `mcp:write`, any other needs
 * `mcp:read` (`mcpOperationScope`), and captured text needs `content:read` on
 * top (`lib/mcp/operations/content-access.ts`).
 */
export const BEARER_ROUTE_SCOPES = {
  "POST /api/v1/traces": "ingest:traces",
  "POST /api/v1/logs": "ingest:logs",
  "POST /api/v1/events": "ingest:events",
  "GET /api/v1/catalog": "catalog:read",
  "GET /api/v2/catalog": "catalog:read",
  "PUT /api/v1/catalog/snapshot": "catalog:write",
  "GET /api/v1/skills": "skills:read",
  "POST /api/v1/skills": "skills:write",
  "GET /api/v1/skills/[id]": "skills:read",
  "PATCH /api/v1/skills/[id]": "skills:write",
  "POST /api/v1/skills/import": "skills:write",
  "POST /api/v1/skills/[id]/publish": "skills:write",
  "POST /api/v1/skills/[id]/archive": "skills:write",
  "GET /api/v1/runtime-catalog/overrides": "runtime_catalog:read",
  "GET /api/v1/jobs/[id]": "jobs:read",
  "GET /api/v1/intent-graph": "intent_graph:read",
  "PUT /api/v1/intent-graph": "intent_graph:write",
  "POST /api/v1/embeddings": "embeddings",
  "POST /api/v1/pick": "tool_picker",
  "POST /api/v1/tools/pick": "tool_picker",
  "GET /api/v1/sandboxes": "sandboxes:read",
  "POST /api/v1/sandboxes/versions": "sandboxes:write",
  "GET /api/v1/sandboxes/versions/[versionId]": "sandboxes:read",
  "PUT /api/v1/sandboxes/versions/[versionId]/bundle": "sandboxes:write",
  "POST /api/v1/sandboxes/versions/[versionId]/finalize": "sandboxes:write",
} as const satisfies Record<string, ApiKeyScope>;

export type BearerRoute = keyof typeof BEARER_ROUTE_SCOPES;

/** The MCP route, declared per tool rather than per route. */
export const MCP_ROUTE = "POST /api/mcp";

/** Reached with the internal secret, never with an API key (lib/platform/internal-auth). */
export const INTERNAL_KEY_LOOKUP_ROUTE = "POST /api/internal/keys/resolve";

/** The scope one MCP tool needs from an API key. */
export function mcpOperationScope(operation: { mutates: boolean }): ApiKeyScope {
  return operation.mutates ? "mcp:write" : "mcp:read";
}
