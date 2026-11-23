import type { TopicTurn, TurnAskText } from "@/lib/readings/topics/asks";

/**
 * Derived asks (RC-743, flag `cloud-tool-run-insights`): a tool-only run, such
 * as an MCP server's own calls, carries no user message, prompt or search, so
 * it has no ask and no intent. Such a turn reads a stand-in: the name of its
 * labelled task, else its tool path ("task define, task update"). The source
 * `derived` marks it as not the user's words. Pure and deterministic, so the
 * same run gives the same text and its cached placement is reused.
 */

/** Most tools a tool path names; the rest are counted. */
const MAX_PATH_TOOLS = 4;
/** `mcp__<server>__<tool>`: the server is the same for every call, so only the tool is named. */
const MCP_TOOL = /^mcp__.+__(.+)$/;
const SKILL_PREFIX = "skill:";

/**
 * A derived ask for each turn that called a tool and has no ask of its own
 * (`withAsk`): its task's label name, else its tool path.
 */
export function derivedAsks(
  turns: readonly Pick<TopicTurn, "id" | "calls" | "workflowId">[],
  withAsk: ReadonlySet<string>,
  taskLabels: ReadonlyMap<string, { readonly name: string }>,
): Map<string, TurnAskText> {
  const out = new Map<string, TurnAskText>();
  for (const turn of turns) {
    if (withAsk.has(turn.id)) continue;
    const label = turn.workflowId ? taskLabels.get(turn.workflowId)?.name.trim() : undefined;
    const text = label || toolPathAsk(turn.calls.map((call) => call.tool));
    if (text) out.set(turn.id, { text, source: "derived" });
  }
  return out;
}

/** The distinct tools in first-call order, as readable words, at most {@link MAX_PATH_TOOLS}; null with no call. */
export function toolPathAsk(tools: readonly string[]): string | null {
  const names = [...new Set(tools.map(humanizeTool).filter((name) => name !== ""))];
  if (names.length === 0) return null;
  const shown = names.slice(0, MAX_PATH_TOOLS).join(", ");
  const rest = names.length - MAX_PATH_TOOLS;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

/** `mcp__beluga_board__task_define` → `task define`; `skill:review.failures` → `review failures`; `listTraces` → `list traces`. */
function humanizeTool(id: string): string {
  const bare = id.startsWith(SKILL_PREFIX)
    ? id.slice(SKILL_PREFIX.length)
    : (MCP_TOOL.exec(id)?.[1] ?? id);
  return bare
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.:/\s]+/g, " ")
    .trim()
    .toLowerCase();
}
