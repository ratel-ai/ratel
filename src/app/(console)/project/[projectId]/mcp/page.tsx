import { notFound } from "next/navigation";
import { McpServersView } from "@/components/console/mcp-servers/McpServersView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
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
import { mcpServerHref } from "@/lib/views/mcp-servers/paths";
import { listMcpServers, type McpServerList } from "@/lib/views/mcp-servers/queries";
import { projectEntitiesEnabledForProject } from "@/lib/views/project-entities/flag";
import {
  listMcpServerExtras,
  type McpServerExtras,
  mcpServerId,
  windowDays,
} from "@/lib/views/project-entities/queries";
import { type McpSearchParams, resolveMcpPageContext } from "./context";

export const dynamic = "force-dynamic";
export const metadata = { title: "MCP servers" };

type Loaded = {
  list: McpServerList;
  extras: Map<string, McpServerExtras>;
  overrides: AgentOverride[];
} | null;

/**
 * The project's MCP servers (RC-777), behind `FF_AGENTS_PAGES`, in the approved RP-25 design:
 * each server side with its calls per day, tools, calling agents (by their override names) and
 * last error.
 */
export default async function McpServersPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<McpSearchParams>;
}) {
  const { projectId } = await params;
  if (!(await projectEntitiesEnabledForProject(projectId))) notFound();
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="MCP servers">
        MCP servers become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const context = await resolveMcpPageContext(projectId, await searchParams);
  const { project, organization, range, environment, window, query } = context;

  const loaded = await loadOrFallback<Loaded>({
    operation: "mcp_servers_list",
    distinctId: `project:${project.id}`,
    fallback: null,
    load: () =>
      withStatementTimeout(
        async (db) => {
          const [list, extras, overrides] = await Promise.all([
            listMcpServers(project.id, window, db),
            listMcpServerExtras(project.id, window, db),
            createDrizzleAgentStore(db).listOverrides(project.id),
          ]);
          return { list, extras, overrides };
        },
        { operation: "mcp_servers_list" },
      ),
  });

  await afterOutsideSupportSession(() =>
    trackProductEvent(
      "mcp_servers_viewed",
      { externalId: context.externalId, orgId: organization.id, projectId: project.id },
      {
        view: "list",
        servers: loaded?.list.servers.length ?? 0,
        environment_filtered: environment !== null,
      },
    ),
  );

  const view = overrideView(loaded?.overrides ?? []);
  const agentName = (key: string) => displayNameOf(view, canonicalKey(view, key));
  const days = windowDays(window);
  return (
    <McpServersView
      now={new Date().toISOString()}
      servers={
        loaded
          ? loaded.list.servers.map((row) => {
              const extras = loaded.extras.get(mcpServerId(row.key, row.role));
              return {
                ...row,
                firstSeenAt: row.firstSeenAt.toISOString(),
                lastSeenAt: row.lastSeenAt.toISOString(),
                href: mcpServerHref(project.id, row.key, { ...query, role: row.role }),
                daily: extras?.daily ?? new Array(days).fill(0),
                tools: extras?.tools ?? [],
                agents: [...new Set((extras?.agents ?? []).map(agentName))],
                lastError: extras?.lastError ?? null,
              };
            })
          : null
      }
      filters={{
        environments: loaded?.list.environments ?? [],
        environment,
        range: { preset: range.preset, from: range.from, to: range.to },
      }}
    />
  );
}
