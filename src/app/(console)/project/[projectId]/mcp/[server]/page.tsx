import {
  type McpServerDetailModel,
  McpServerDetailView,
} from "@/components/console/mcp-servers/McpServerDetailView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { projectRoot } from "@/lib/console/navigation";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { afterOutsideSupportSession } from "@/lib/platform/support-session";
import { trackProductEvent } from "@/lib/platform/telemetry";
import { createDrizzleAgentStore } from "@/lib/views/agents/adapters/drizzle-store";
import {
  type AgentOverride,
  canonicalKey,
  displayNameOf,
  overrideView,
} from "@/lib/views/agents/domain/overrides";
import type { AgentHandoff } from "@/lib/views/agents/domain/types";
import { agentHref } from "@/lib/views/agents/paths";
import {
  MCP_ROLE_PARAM,
  mcpServerCatalogHref,
  mcpServerHref,
  mcpServersHref,
  mcpServerTracesHref,
  parseMcpRole,
  parseMcpServerKey,
} from "@/lib/views/mcp-servers/paths";
import {
  getMcpServer,
  listMcpEnvironments,
  type McpServerDetail,
} from "@/lib/views/mcp-servers/queries";
import {
  getMcpServerDetailExtras,
  type McpServerDetailExtras,
} from "@/lib/views/project-entities/queries";
import { type McpSearchParams, resolveMcpPageContext } from "../context";

export const dynamic = "force-dynamic";
export const metadata = { title: "MCP server" };

type Loaded = {
  detail: McpServerDetail | null;
  extras: McpServerDetailExtras | null;
  environments: string[];
  overrides: AgentOverride[];
  handoffs: AgentHandoff[];
} | null;

/**
 * One MCP server (RC-777): the key is the URL segment, the side `?role=`. The approved RP-25
 * design adds the p50 (or the sample size), each tool's top error and callers, the calling
 * agents' roles and the recent errors. Upstream's Clients link is not here: this edition has no
 * Clients page.
 */
export default async function McpServerPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; server: string }>;
  searchParams: Promise<McpSearchParams>;
}) {
  const { projectId, server: segment } = await params;
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="MCP server">
        MCP servers become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const search = await searchParams;
  const context = await resolveMcpPageContext(projectId, search);
  const { project, organization, range, environment, window, query } = context;
  const key = parseMcpServerKey(segment);
  const role = parseMcpRole(search[MCP_ROLE_PARAM]);

  const loaded = await loadOrFallback<Loaded>({
    operation: "mcp_server_detail",
    distinctId: `project:${project.id}`,
    fallback: null,
    load: () =>
      withStatementTimeout(
        async (db) => {
          const store = createDrizzleAgentStore(db);
          const [detail, environments, overrides, handoffs] = await Promise.all([
            getMcpServer(project.id, { key, ...(role ? { role } : {}) }, window, db),
            listMcpEnvironments(project.id, window, db),
            // RC-776: the calling agents show their override names and merges.
            store.listOverrides(project.id),
            store.listHandoffs(project.id, window, { showHidden: true }),
          ]);
          const extras = detail
            ? await getMcpServerDetailExtras(
                project.id,
                { key: detail.server.key, role: detail.server.role },
                window,
                db,
              )
            : null;
          return { detail, extras, environments, overrides, handoffs };
        },
        { operation: "mcp_server_detail" },
      ),
  });
  const detail = loaded?.detail ?? null;
  const extras = loaded?.extras ?? null;

  await afterOutsideSupportSession(() =>
    trackProductEvent(
      "mcp_servers_viewed",
      { externalId: context.externalId, orgId: organization.id, projectId: project.id },
      {
        view: "detail",
        servers: detail?.roles.length ?? 0,
        environment_filtered: environment !== null,
      },
    ),
  );

  const view = overrideView(loaded?.overrides ?? []);
  const canonical = (agent: string) => canonicalKey(view, agent);
  const nameOf = (agent: string) => displayNameOf(view, canonical(agent));
  const handoffs = loaded?.handoffs ?? [];
  const roleOf = (agent: string) =>
    handoffs.some((edge) => edge.to === agent)
      ? ("sub-agent" as const)
      : handoffs.some((edge) => edge.from === agent)
        ? ("entry" as const)
        : null;
  const callingAgents = new Map<string | null, number>();
  for (const row of detail?.agents ?? []) {
    const agent = row.agent === null ? null : canonical(row.agent);
    callingAgents.set(agent, (callingAgents.get(agent) ?? 0) + row.calls);
  }
  const traces = mcpServerTracesHref(project.id, key, query);

  const model: McpServerDetailModel | null = detail
    ? {
        server: {
          ...detail.server,
          p50Ms: extras?.p50Ms ?? 0,
          firstSeenAt: detail.server.firstSeenAt.toISOString(),
          lastSeenAt: detail.server.lastSeenAt.toISOString(),
        },
        roles: detail.roles.map((each) => ({
          role: each,
          href: mcpServerHref(project.id, key, { ...query, role: each }),
        })),
        tools: detail.tools
          .map((tool) => {
            const found = extras?.tools.get(tool.tool);
            return {
              ...tool,
              topError: found?.topError ?? null,
              callers: [...new Set((found?.callers ?? []).map(nameOf))],
            };
          })
          .sort((a, b) => b.errors - a.errors || b.calls - a.calls || a.tool.localeCompare(b.tool)),
        agents: [...callingAgents]
          .sort((a, b) => b[1] - a[1])
          .map(([agent, calls]) => ({
            name: agent === null ? "No agent named" : displayNameOf(view, agent),
            calls,
            role: agent === null ? null : roleOf(agent),
            href: agent === null ? null : agentHref(project.id, agent, query),
          })),
        recentErrors: (extras?.recent ?? []).map((error) => ({
          tool: error.tool,
          message: error.message,
          agent: error.agent === null ? null : nameOf(error.agent),
          at: error.at.toISOString(),
          traceId: error.traceId,
          href: `${projectRoot(project.id)}/traces/${encodeURIComponent(error.traceId)}`,
        })),
        links: {
          traces,
          failures: `${traces}${traces.includes("?") ? "&" : "?"}status=failed`,
          catalog: mcpServerCatalogHref(project.id, key),
        },
      }
    : null;

  return (
    <McpServerDetailView
      title={detail?.server.displayName ?? key}
      listHref={mcpServersHref(project.id, query)}
      now={new Date().toISOString()}
      detail={model}
      failed={loaded === null}
      filters={{
        environments: loaded?.environments ?? [],
        environment,
        range: { preset: range.preset, from: range.from, to: range.to },
      }}
    />
  );
}
