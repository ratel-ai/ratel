import { z } from "zod";
import { McpOperationError, notFound } from "@/lib/mcp/errors";
import { mcpActor } from "@/lib/mcp/operations/health";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { round } from "@/lib/mcp/serialize";
import { resolveWindow, WINDOW_PRESETS, windowParams } from "@/lib/mcp/windows";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { createDrizzleAgentStore } from "@/lib/views/agents/adapters/drizzle-store";
import type { AgentRow } from "@/lib/views/agents/domain/types";
import { agentHref, agentTracesHref } from "@/lib/views/agents/paths";
import type { AgentStore } from "@/lib/views/agents/ports/store";
import { projectEntitiesEnabledForActor } from "@/lib/views/project-entities/flag";

/**
 * The Agents page over MCP (RC-775): `list_agents` (the list and the
 * handoffs) and `get_agent` (one agent). They read through the page's own
 * `lib/agents` store, behind the page's flag, `cloud-project-entities`: off,
 * they refuse as forbidden, as the page is not found.
 */

export interface AgentsOperationDeps {
  /** `cloud-project-entities` for the caller (`project:<id>` for a key, the identity-provider id for a person) in the project's organization. */
  projectEntitiesEnabled: (projectId: string, actor: string) => Promise<boolean>;
  listAgents: AgentStore["listAgents"];
  listHandoffs: AgentStore["listHandoffs"];
  getAgent: AgentStore["getAgent"];
  now: () => Date;
}

export const defaultAgentsDeps: AgentsOperationDeps = {
  // Owned (ADR-0030): the core's FF_AGENTS_PAGES switch, not upstream's flag service.
  projectEntitiesEnabled: (projectId, actor) => projectEntitiesEnabledForActor(projectId, actor),
  listAgents: (projectId, window) =>
    withStatementTimeout((db) => createDrizzleAgentStore(db).listAgents(projectId, window), {
      operation: "mcp_list_agents",
    }),
  listHandoffs: (projectId, window) =>
    withStatementTimeout((db) => createDrizzleAgentStore(db).listHandoffs(projectId, window), {
      operation: "mcp_list_agent_handoffs",
    }),
  getAgent: (projectId, key, window) =>
    withStatementTimeout((db) => createDrizzleAgentStore(db).getAgent(projectId, key, window), {
      operation: "mcp_get_agent",
    }),
  now: () => new Date(),
};

const environmentParam = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe("Only the runs of this deployment environment. The agents stay the same.");

export function agentsOperations(deps: AgentsOperationDeps = defaultAgentsDeps): McpOperation[] {
  return [
    defineOperation({
      id: "list_agents",
      domain: "observability",
      title: "List agents",
      description:
        "The agents this project's traces show, detected from the spans. Each has runs (traces it ran in), errors, error rate, cost, p95 run latency, first and last seen in the window. Also returns the handoffs: one edge per calling agent and called agent, with a count. Call get_agent for one agent's tools and MCP servers.",
      keywords: [
        "agents",
        "multi-agent",
        "sub-agents",
        "agent handoffs",
        "which agent calls which",
      ],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped, ...windowParams, environment: environmentParam }),
      async execute(ctx, params) {
        await requireProjectEntities(deps, ctx.projectId, mcpActor(ctx.auth, ctx.projectId));
        const resolved = resolveWindow(params, WINDOW_PRESETS.entities, deps.now());
        const window = {
          since: resolved.since,
          until: resolved.until,
          environment: params.environment ?? null,
        };
        const [list, handoffs] = await Promise.all([
          deps.listAgents(ctx.projectId, window),
          deps.listHandoffs(ctx.projectId, window),
        ]);
        return {
          data: {
            agents: list.agents.map((row) => ({
              ...agentView(row),
              href: agentHref(ctx.projectId, row.key),
            })),
            handoffs,
            environments: list.environments,
          },
          window: resolved.toJSON(),
          ...(list.agents.length === 0
            ? {
                hint: "No agent span in this window. Widen it with since, or check get_traces_ingest_diagnostics.",
              }
            : {}),
        };
      },
    }),
    defineOperation({
      id: "get_agent",
      domain: "observability",
      title: "Get an agent",
      description:
        "One agent from list_agents: its stats, the tools it calls (calls, errors, p95 latency), the MCP servers it calls, and the agents it hands work to and gets work from.",
      keywords: ["agent tools", "agent mcp servers", "agent handoffs"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        agent: z.string().min(1).max(256).describe("The agent key, as list_agents returns it."),
        ...windowParams,
        environment: environmentParam,
      }),
      async execute(ctx, params) {
        await requireProjectEntities(deps, ctx.projectId, mcpActor(ctx.auth, ctx.projectId));
        const resolved = resolveWindow(params, WINDOW_PRESETS.entities, deps.now());
        const detail = await deps.getAgent(ctx.projectId, params.agent, {
          since: resolved.since,
          until: resolved.until,
          environment: params.environment ?? null,
        });
        if (!detail) throw notFound("agent with runs in this window");
        return {
          data: {
            ...agentView(detail.agent),
            tools: detail.tools.map((tool) => ({
              ...tool,
              errorRate: round(tool.errorRate),
              p95Ms: round(tool.p95Ms, 2),
            })),
            mcpServers: detail.mcpServers,
            callers: detail.callers,
            callees: detail.callees,
            href: agentHref(ctx.projectId, detail.agent.key),
            tracesHref: agentTracesHref(ctx.projectId, [
              detail.agent.key,
              ...detail.agent.mergedKeys,
            ]),
          },
          window: resolved.toJSON(),
        };
      },
    }),
  ];
}

async function requireProjectEntities(
  deps: AgentsOperationDeps,
  projectId: string,
  actor: string,
): Promise<void> {
  if (!(await deps.projectEntitiesEnabled(projectId, actor))) {
    throw new McpOperationError("forbidden", "Agents are not available for this project.", {
      reason: "project_entities_off",
    });
  }
}

function agentView(row: AgentRow) {
  return {
    key: row.key,
    name: row.displayName,
    ...(row.mergedKeys.length > 0 ? { mergedKeys: row.mergedKeys } : {}),
    runs: row.calls,
    errors: row.errors,
    errorRate: round(row.errorRate),
    costUsd: row.costUsd,
    p95Ms: round(row.p95Ms, 2),
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}
