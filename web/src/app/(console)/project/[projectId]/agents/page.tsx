import { notFound } from "next/navigation";
import { AgentsView } from "@/components/console/agents/AgentsView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { afterOutsideSupportSession } from "@/lib/platform/support-session";
import { trackProductEvent } from "@/lib/platform/telemetry";
import { createDrizzleAgentStore } from "@/lib/views/agents/adapters/drizzle-store";
import { overrideView } from "@/lib/views/agents/domain/overrides";
import type { AgentHandoff, AgentList } from "@/lib/views/agents/domain/types";
import { agentHref } from "@/lib/views/agents/paths";
import { projectEntitiesEnabledForProject } from "@/lib/views/project-entities/flag";
import {
  type AgentListExtras,
  listAgentExtras,
  windowDays,
} from "@/lib/views/project-entities/queries";
import { type AgentsSearchParams, resolveAgentsPageContext } from "./context";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agents" };

type Loaded = { list: AgentList; handoffs: AgentHandoff[]; extras: AgentListExtras } | null;

/**
 * The project's agents and their handoffs (RC-775), behind `FF_AGENTS_PAGES`, in the approved
 * RP-25 design: an admin's list always reads the hidden agents too, to count them for
 * "Hidden (n)", and shows them only with `?showHidden=1`.
 */
export default async function AgentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<AgentsSearchParams>;
}) {
  const { projectId } = await params;
  if (!(await projectEntitiesEnabledForProject(projectId))) notFound();
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Agents">
        Agents become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const context = await resolveAgentsPageContext(projectId, await searchParams);
  const { project, organization, range, environment, window, query, showHidden, canEdit } = context;
  const readHidden = canEdit;

  const loaded = await loadOrFallback<Loaded>({
    operation: "agents_list",
    distinctId: `project:${project.id}`,
    fallback: null,
    load: () =>
      withStatementTimeout(
        async (db) => {
          const store = createDrizzleAgentStore(db);
          const [list, handoffs, overrides] = await Promise.all([
            store.listAgents(project.id, window, { showHidden: readHidden }),
            store.listHandoffs(project.id, window, { showHidden: readHidden }),
            store.listOverrides(project.id),
          ]);
          const extras = await listAgentExtras(
            project.id,
            window,
            overrideView(overrides).merges,
            db,
          );
          return { list, handoffs, extras };
        },
        { operation: "agents_list" },
      ),
  });
  const all = loaded?.list.agents ?? [];
  const shown = showHidden ? all : all.filter((row) => !row.hidden);
  const shownKeys = new Set(shown.map((row) => row.key));

  await afterOutsideSupportSession(() =>
    trackProductEvent(
      "agents_viewed",
      { externalId: context.externalId, orgId: organization.id, projectId: project.id },
      {
        view: "list",
        agents: shown.length,
        handoffs: loaded?.handoffs.length ?? 0,
        environment_filtered: environment !== null,
      },
    ),
  );

  const days = windowDays(window);
  return (
    <AgentsView
      now={new Date().toISOString()}
      agents={
        loaded
          ? shown.map((row) => ({
              ...row,
              firstSeenAt: row.firstSeenAt.toISOString(),
              lastSeenAt: row.lastSeenAt.toISOString(),
              href: agentHref(project.id, row.key, query),
              daily: loaded.extras.daily.get(row.key) ?? new Array(days).fill(0),
              mcpServers: loaded.extras.mcpServers.get(row.key) ?? 0,
            }))
          : null
      }
      handoffs={(loaded?.handoffs ?? []).filter(
        (edge) => shownKeys.has(edge.from) && shownKeys.has(edge.to),
      )}
      hiddenCount={all.filter((row) => row.hidden).length}
      canEdit={canEdit}
      showHidden={showHidden}
      filters={{
        environments: loaded?.list.environments ?? [],
        environment,
        range: { preset: range.preset, from: range.from, to: range.to },
      }}
    />
  );
}
