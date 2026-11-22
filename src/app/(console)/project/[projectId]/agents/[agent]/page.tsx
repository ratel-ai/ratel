import {
  type AgentDetailModel,
  AgentDetailView,
  type FlowAgent,
} from "@/components/console/agents/AgentDetailView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { afterOutsideSupportSession } from "@/lib/platform/support-session";
import { trackProductEvent } from "@/lib/platform/telemetry";
import { createDrizzleAgentStore } from "@/lib/views/agents/adapters/drizzle-store";
import type { AgentDetail, AgentHandoff, AgentRow } from "@/lib/views/agents/domain/types";
import {
  agentHref,
  agentOverridesApiHref,
  agentsHref,
  agentTracesHref,
  parseAgentKey,
} from "@/lib/views/agents/paths";
import { mcpServerHref } from "@/lib/views/mcp-servers/paths";
import { type AgentToolEntry, groupAgentTools } from "@/lib/views/project-entities/agents-model";
import { listAgentTools } from "@/lib/views/project-entities/queries";
import { type AgentsSearchParams, resolveAgentsPageContext } from "../context";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agent" };

type Loaded = {
  detail: AgentDetail | null;
  environments: string[];
  /** Every agent of the window, hidden ones too: the flow strip's numbers and the merge targets. */
  others: AgentRow[];
  tools: AgentToolEntry[];
  overrideName: string | null;
} | null;

/**
 * One agent (RC-775): the key is the URL segment. The approved RP-25 design: the tools come
 * grouped by MCP server with their last error, the flow strip shows each neighbour's numbers, and
 * the corrections sit in the admin's Edit agent menu.
 */
export default async function AgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; agent: string }>;
  searchParams: Promise<AgentsSearchParams>;
}) {
  const { projectId, agent: segment } = await params;
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Agent">
        Agents become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const context = await resolveAgentsPageContext(projectId, await searchParams);
  const { project, organization, range, environment, window, query, canEdit } = context;
  const key = parseAgentKey(segment);

  const loaded = await loadOrFallback<Loaded>({
    operation: "agent_detail",
    distinctId: `project:${project.id}`,
    fallback: null,
    load: () =>
      withStatementTimeout(
        async (db) => {
          const store = createDrizzleAgentStore(db);
          const [detail, environments, overrides, list] = await Promise.all([
            store.getAgent(project.id, key, window),
            store.listAgentEnvironments(project.id, window),
            store.listOverrides(project.id),
            store.listAgents(project.id, window, { showHidden: true }),
          ]);
          const tools = detail
            ? await listAgentTools(
                project.id,
                [detail.agent.key, ...detail.agent.mergedKeys],
                window,
                db,
              )
            : [];
          const overrideName =
            overrides.find((row) => row.agentKey === detail?.agent.key)?.displayName ?? null;
          return { detail, environments, others: list.agents, tools, overrideName };
        },
        { operation: "agent_detail" },
      ),
  });
  const detail = loaded?.detail ?? null;

  await afterOutsideSupportSession(() =>
    trackProductEvent(
      "agents_viewed",
      { externalId: context.externalId, orgId: organization.id, projectId: project.id },
      {
        view: "detail",
        agents: detail ? 1 : 0,
        handoffs: (detail?.callers.length ?? 0) + (detail?.callees.length ?? 0),
        environment_filtered: environment !== null,
      },
    ),
  );

  const byKey = new Map((loaded?.others ?? []).map((row) => [row.key, row]));
  const flow = (edge: AgentHandoff, side: "from" | "to"): FlowAgent => {
    const other = byKey.get(edge[side]);
    return {
      key: edge[side],
      name: side === "from" ? edge.fromName : edge.toName,
      count: edge.count,
      href: agentHref(project.id, edge[side], query),
      runs: other?.calls ?? null,
      errorRate: other?.errorRate ?? null,
    };
  };
  const keys = detail ? [detail.agent.key, ...detail.agent.mergedKeys] : [];
  const traces = agentTracesHref(project.id, keys, query);
  const groups = groupAgentTools(loaded?.tools ?? []);
  const model: AgentDetailModel | null = detail
    ? {
        agent: {
          ...detail.agent,
          firstSeenAt: detail.agent.firstSeenAt.toISOString(),
          lastSeenAt: detail.agent.lastSeenAt.toISOString(),
        },
        role: detail.callers.length > 0 ? "sub-agent" : detail.callees.length > 0 ? "entry" : null,
        mcpServers: detail.mcpServers.length,
        callers: detail.callers.map((edge) => flow(edge, "from")),
        callees: detail.callees.map((edge) => flow(edge, "to")),
        tools: groups,
        serverHrefs: Object.fromEntries(
          groups
            .filter((group) => group.server !== null)
            .map((group) => [
              group.server,
              mcpServerHref(project.id, group.server as string, { ...query, role: "consumed" }),
            ]),
        ),
        links: { traces, failures: `${traces}${traces.includes("?") ? "&" : "?"}status=failed` },
        ...(canEdit
          ? {
              edit: {
                apiHref: agentOverridesApiHref(project.id),
                displayName: loaded?.overrideName ?? null,
                mergeTargets: (loaded?.others ?? [])
                  .filter((row) => row.key !== detail.agent.key)
                  .map((row) => ({ key: row.key, name: row.displayName })),
              },
            }
          : {}),
      }
    : null;

  return (
    <AgentDetailView
      title={detail?.agent.displayName ?? key}
      listHref={agentsHref(project.id, query)}
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
