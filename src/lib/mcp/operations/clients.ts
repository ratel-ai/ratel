import { z } from "zod";
import { McpOperationError } from "@/lib/mcp/errors";
import { mcpActor } from "@/lib/mcp/operations/health";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { round } from "@/lib/mcp/serialize";
import { resolveWindow, WINDOW_PRESETS, windowParams } from "@/lib/mcp/windows";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import {
  type ClientsOverview,
  type ClientsWindow,
  getClientsOverview,
  type HarnessRow,
} from "@/lib/views/clients/queries";
import { mcpClientsHref } from "@/lib/views/mcp-servers/paths";
import { projectEntitiesEnabledForActor } from "@/lib/views/project-entities/flag";

/**
 * The Clients tab over MCP (RC-778): `list_clients`, the same read as the tab
 * (`views/clients`), behind the same switch (`FF_AGENTS_PAGES`, upstream's
 * `cloud-project-entities`; off, it refuses as forbidden). It returns harnesses, versions, countries,
 * transports and protocol versions. It never returns a caller's raw IP: the
 * query selects none.
 */

export interface ClientsOperationDeps {
  projectEntitiesEnabled: (projectId: string, actor: string) => Promise<boolean>;
  getClientsOverview: (projectId: string, window: ClientsWindow) => Promise<ClientsOverview>;
  now: () => Date;
}

export const defaultClientsDeps: ClientsOperationDeps = {
  // Owned (ADR-0030): the core's FF_AGENTS_PAGES switch, not upstream's flag service.
  projectEntitiesEnabled: (projectId, actor) => projectEntitiesEnabledForActor(projectId, actor),
  getClientsOverview: (projectId, window) =>
    withStatementTimeout((db) => getClientsOverview(projectId, window, db), {
      operation: "mcp_list_clients",
    }),
  now: () => new Date(),
};

const UNKNOWN_CLIENT_HINT =
  "harness null is an unknown client: the MCP server reported no client. A stdio server reports none on the standard OpenTelemetry path; an HTTP server reports one through its HTTP server span's User-Agent.";

export function clientsOperations(deps: ClientsOperationDeps = defaultClientsDeps): McpOperation[] {
  return [
    defineOperation({
      id: "list_clients",
      domain: "observability",
      title: "List MCP clients",
      description:
        "Who calls this project's MCP servers: calls, sessions, error rate and first seen per harness (claude-code, codex, cursor, opencode, vscode, other) and per harness version, calls per caller country (ISO code), and the transport and MCP protocol version splits. A null harness is an unknown client.",
      keywords: [
        "mcp clients",
        "harnesses calling my mcp server",
        "claude code codex cursor usage",
        "mcp callers by country",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        ...windowParams,
        server: z
          .string()
          .min(1)
          .max(256)
          .optional()
          .describe(
            "One MCP server key, as list_mcp_servers returns it. Absent: every server the project provides.",
          ),
        environment: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Only the calls of this deployment environment (deployment.environment.name)."),
      }),
      async execute(ctx, params) {
        if (
          !(await deps.projectEntitiesEnabled(ctx.projectId, mcpActor(ctx.auth, ctx.projectId)))
        ) {
          throw new McpOperationError(
            "forbidden",
            "MCP clients are not available for this project.",
            { reason: "project_entities_off" },
          );
        }
        const window = resolveWindow(params, WINDOW_PRESETS.entities, deps.now());
        const overview = await deps.getClientsOverview(ctx.projectId, {
          since: window.since,
          until: window.until,
          server: params.server ?? null,
          environment: params.environment ?? null,
        });
        const unknown = overview.harnesses.some((row) => row.harness === null);
        return {
          data: {
            harnesses: overview.harnesses.map(harnessView),
            versions: overview.versions.map((row) => ({
              ...harnessView(row),
              version: row.version,
            })),
            countries: overview.countries,
            transports: overview.transports,
            protocolVersions: overview.protocolVersions,
            servers: overview.servers,
            environments: overview.environments,
            href: mcpClientsHref(ctx.projectId, { server: params.server ?? null }),
          },
          window: window.toJSON(),
          ...(overview.harnesses.length === 0
            ? {
                hint: "No call to a provided MCP server in this window. Widen it with since, or call list_mcp_servers.",
              }
            : unknown
              ? { hint: UNKNOWN_CLIENT_HINT }
              : {}),
        };
      },
    }),
  ];
}

function harnessView(row: HarnessRow) {
  return {
    harness: row.harness,
    calls: row.calls,
    errors: row.errors,
    errorRate: round(row.errorRate),
    sessions: row.sessions,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}
