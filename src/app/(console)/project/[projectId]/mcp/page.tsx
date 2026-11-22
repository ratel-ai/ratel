import { TabNav } from "@ratel/design-system/tabs";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { type ClientsOverviewView, ClientsView } from "@/components/console/clients/ClientsView";
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
import { type ClientsOverview, getClientsOverview } from "@/lib/views/clients/queries";
import {
  MCP_CLIENTS_TAB,
  MCP_SERVER_PARAM,
  MCP_TAB_PARAM,
  mcpClientsHref,
  mcpServerHref,
  mcpServersHref,
} from "@/lib/views/mcp-servers/paths";
import { listMcpServers, type McpServerList } from "@/lib/views/mcp-servers/queries";
import { projectEntitiesEnabledForProject } from "@/lib/views/project-entities/flag";
import {
  listMcpServerExtras,
  type McpServerExtras,
  mcpServerId,
  windowDays,
} from "@/lib/views/project-entities/queries";
import { type McpPageContext, type McpSearchParams, resolveMcpPageContext } from "./context";

export const dynamic = "force-dynamic";
export const metadata = { title: "MCP servers" };

type Loaded = {
  list: McpServerList;
  extras: Map<string, McpServerExtras>;
  overrides: AgentOverride[];
} | null;

/**
 * The project's MCP servers (RC-777), behind `FF_AGENTS_PAGES`, in two tabs: Servers (the
 * default, the approved RP-25 design: each server side with its calls per day, tools, calling
 * agents by their override names, and last error) and Clients (`?tab=clients`, RC-778: who calls
 * the project's servers).
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
  const search = await searchParams;
  const context = await resolveMcpPageContext(projectId, search);
  const clientsTab = text(search[MCP_TAB_PARAM]) === MCP_CLIENTS_TAB;
  const server = clientsTab ? text(search[MCP_SERVER_PARAM])?.trim() || null : null;
  const tabs = <McpTabs context={context} clientsTab={clientsTab} />;
  return clientsTab ? (
    <ClientsTab context={context} server={server} tabs={tabs} />
  ) : (
    <ServersTab context={context} tabs={tabs} />
  );
}

function McpTabs({ context, clientsTab }: { context: McpPageContext; clientsTab: boolean }) {
  const { project, query } = context;
  return (
    <TabNav
      label="MCP servers"
      tabs={[
        { href: mcpServersHref(project.id, query), label: "Servers", current: !clientsTab },
        { href: mcpClientsHref(project.id, query), label: "Clients", current: clientsTab },
      ]}
    />
  );
}

async function ServersTab({ context, tabs }: { context: McpPageContext; tabs: ReactNode }) {
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
      tabs={tabs}
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

async function ClientsTab({
  context,
  server,
  tabs,
}: {
  context: McpPageContext;
  server: string | null;
  tabs: ReactNode;
}) {
  const { project, organization, range, environment, window } = context;
  const overview = await loadOrFallback<ClientsOverview | null>({
    operation: "mcp_clients_overview",
    distinctId: `project:${project.id}`,
    fallback: null,
    load: () =>
      withStatementTimeout((db) => getClientsOverview(project.id, { ...window, server }, db), {
        operation: "mcp_clients_overview",
      }),
  });

  await afterOutsideSupportSession(() =>
    trackProductEvent(
      "mcp_clients_viewed",
      { externalId: context.externalId, orgId: organization.id, projectId: project.id },
      {
        harnesses: overview?.harnesses.length ?? 0,
        countries: overview?.countries.length ?? 0,
        server_filtered: server !== null,
        environment_filtered: environment !== null,
      },
    ),
  );

  return (
    <ClientsView
      now={new Date().toISOString()}
      tabs={tabs}
      overview={overview ? toView(overview) : null}
      filters={{
        servers: overview?.servers ?? [],
        server,
        environments: overview?.environments ?? [],
        environment,
        range: { preset: range.preset, from: range.from, to: range.to },
      }}
    />
  );
}

/** Dates to ISO strings for the client component; the filter options travel in `filters`. */
function toView(overview: ClientsOverview): ClientsOverviewView {
  return {
    countries: overview.countries,
    transports: overview.transports,
    protocolVersions: overview.protocolVersions,
    harnesses: overview.harnesses.map((row) => ({
      ...row,
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
    })),
    versions: overview.versions.map((row) => ({
      ...row,
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
    })),
  };
}

function text(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
