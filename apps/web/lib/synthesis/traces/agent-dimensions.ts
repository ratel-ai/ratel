/**
 * The coding-agent dimensions of a span (AOBS-5):
 * which MCP server a tool call went to, which shell command it ran, which
 * skill it loaded and which agent (the main agent or a sub-agent type) made
 * it. AOBS-7 adds where the work was done: the chat (the conversation of the
 * span), and the task and the repository of the span's run. Pure names and labels, safe for the client; the SQL that reads them is
 * in `span-dimensions.ts`.
 */

export const AGENT_DIMENSIONS = [
  "server",
  "command",
  "skill",
  "agent",
  "chat",
  "task",
  "repo",
] as const;
export type AgentDimension = (typeof AGENT_DIMENSIONS)[number];

/** An exact value of each dimension a span list or aggregate keeps. */
export type AgentDimensionFilters = Partial<Record<AgentDimension, string>>;

export const AGENT_DIMENSION_LABEL: Readonly<Record<AgentDimension, string>> = {
  server: "MCP server",
  command: "Command",
  skill: "Skill",
  agent: "Agent",
  chat: "Chat",
  task: "Task",
  repo: "Repository",
};

export function isAgentDimension(value: string | null | undefined): value is AgentDimension {
  return (AGENT_DIMENSIONS as readonly string[]).includes(value ?? "");
}

/** The dimension filters of a page's search params: trimmed, and absent when empty. */
export function agentDimensionFiltersOf(
  params: Readonly<Record<string, string | readonly string[] | undefined>>,
): AgentDimensionFilters {
  const out: AgentDimensionFilters = {};
  for (const dimension of AGENT_DIMENSIONS) {
    const raw = params[dimension];
    const value = (typeof raw === "string" ? raw : raw?.[0])?.trim();
    if (value) out[dimension] = value;
  }
  return out;
}
