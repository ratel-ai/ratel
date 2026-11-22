import { z } from "zod";
import { notFound } from "@/lib/mcp/errors";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { round } from "@/lib/mcp/serialize";
import { resolveWindow, WINDOW_PRESETS, windowParams } from "@/lib/mcp/windows";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import {
  mcpServerCatalogHref,
  mcpServerHref,
  mcpServerTracesHref,
} from "@/lib/views/mcp-servers/paths";
import { getMcpServer, listMcpServers, type McpServerRow } from "@/lib/views/mcp-servers/queries";

/**
 * The MCP servers page over MCP (RC-777): `list_mcp_servers` (the list) and
 * `get_mcp_server` (one server). They read through the page's own
 * `lib/mcp-servers` queries.
 */

export interface McpServersOperationDeps {
  listMcpServers: (
    projectId: string,
    window: Parameters<typeof listMcpServers>[1],
  ) => ReturnType<typeof listMcpServers>;
  getMcpServer: (
    projectId: string,
    ref: Parameters<typeof getMcpServer>[1],
    window: Parameters<typeof getMcpServer>[2],
  ) => ReturnType<typeof getMcpServer>;
  now: () => Date;
}

export const defaultMcpServersDeps: McpServersOperationDeps = {
  listMcpServers: (projectId, window) =>
    withStatementTimeout((db) => listMcpServers(projectId, window, db), {
      operation: "mcp_list_mcp_servers",
    }),
  getMcpServer: (projectId, ref, window) =>
    withStatementTimeout((db) => getMcpServer(projectId, ref, window, db), {
      operation: "mcp_get_mcp_server",
    }),
  now: () => new Date(),
};

const environmentParam = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe(
    "Only the calls of this deployment environment (deployment.environment.name). The servers stay the same.",
  );

export function mcpServersOperations(
  deps: McpServersOperationDeps = defaultMcpServersDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "list_mcp_servers",
      domain: "observability",
      title: "List MCP servers",
      description:
        "The MCP servers this project's traces show, one row per server and side: provided (the server's own spans) or consumed (an agent's calls to it). Each has calls, error rate, p95 latency, sessions, first and last seen in the window. Call get_mcp_server for one server's tools and calling agents.",
      keywords: ["mcp servers", "model context protocol servers", "servers my agents call"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped, ...windowParams, environment: environmentParam }),
      async execute(ctx, params) {
        const window = resolveWindow(params, WINDOW_PRESETS.entities, deps.now());
        const list = await deps.listMcpServers(ctx.projectId, {
          since: window.since,
          until: window.until,
          environment: params.environment ?? null,
        });
        return {
          data: {
            servers: list.servers.map((row) => ({
              ...serverView(row),
              href: mcpServerHref(ctx.projectId, row.key, { role: row.role }),
            })),
            environments: list.environments,
          },
          window: window.toJSON(),
          ...(list.servers.length === 0
            ? {
                hint: "No MCP call in this window. Widen it with since, or check get_traces_ingest_diagnostics.",
              }
            : {}),
        };
      },
    }),
    defineOperation({
      id: "get_mcp_server",
      domain: "observability",
      title: "Get an MCP server",
      description:
        "One MCP server from list_mcp_servers: its stats, per-tool calls, errors and p50/p95 latency, the agents that call it, and the protocol versions and transports in use when the spans name them.",
      keywords: ["mcp server tools", "mcp tool latency", "agents calling an mcp server"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        server: z
          .string()
          .min(1)
          .max(256)
          .describe("The server key, as list_mcp_servers returns it."),
        role: z
          .enum(["provided", "consumed"])
          .optional()
          .describe("Which side: provided or consumed. Defaults to the side with the most calls."),
        ...windowParams,
        environment: environmentParam,
      }),
      async execute(ctx, params) {
        const window = resolveWindow(params, WINDOW_PRESETS.entities, deps.now());
        const detail = await deps.getMcpServer(
          ctx.projectId,
          { key: params.server, ...(params.role ? { role: params.role } : {}) },
          { since: window.since, until: window.until, environment: params.environment ?? null },
        );
        if (!detail) throw notFound("MCP server with calls in this window");
        return {
          data: {
            ...serverView(detail.server),
            roles: detail.roles,
            tools: detail.tools.map((tool) => ({
              ...tool,
              errorRate: round(tool.errorRate),
              p50Ms: round(tool.p50Ms, 2),
              p95Ms: round(tool.p95Ms, 2),
            })),
            agents: detail.agents,
            ...(detail.protocolVersions ? { protocolVersions: detail.protocolVersions } : {}),
            ...(detail.transports ? { transports: detail.transports } : {}),
            href: mcpServerHref(ctx.projectId, detail.server.key, { role: detail.server.role }),
            tracesHref: mcpServerTracesHref(ctx.projectId, detail.server.key),
            catalogHref: mcpServerCatalogHref(ctx.projectId, detail.server.key),
          },
          window: window.toJSON(),
        };
      },
    }),
  ];
}

function serverView(row: McpServerRow) {
  return {
    key: row.key,
    role: row.role,
    name: row.displayName,
    version: row.version,
    calls: row.calls,
    errors: row.errors,
    errorRate: round(row.errorRate),
    p95Ms: round(row.p95Ms, 2),
    sessions: row.sessions,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}
