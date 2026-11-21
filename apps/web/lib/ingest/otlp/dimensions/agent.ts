import { attrString } from "../anyvalue";
import { AGENT_KEYS, ancestorsOf, firstString, resolveUp } from "../attr-resolve";
import { GEN_AI } from "../constants";
import type { DecodedSpan } from "../types";
import { type DetectSource, entityKey } from "./keys";

/**
 * Which agent a span ran under. Two readings live here:
 *
 * - {@link namedAgentOf}: the name the turn ledger payload carries
 *   (`payload.agent`). Its rules are frozen, so stored payloads do not change.
 * - {@link agentKeyOf}: the entity key of the agent, for the `agent_key`
 *   columns. It reads more rules, and ends at the service name, so every span
 *   of an agent's service has a key.
 */

/** How the named agent of a span was found. */
export type AgentSource =
  /** An agent attribute (`AGENT_KEYS`) on the span, an ancestor or the resource. */
  | "attribute"
  /** The span name of the nearest `invoke_agent` ancestor. */
  | "invoke_agent";

export interface SpanAgent {
  name: string;
  source: AgentSource;
}

export interface AgentKey {
  key: string;
  source: DetectSource;
}

/**
 * The agent field of the Ratel SDK. Reserved: the SDK does not send it yet
 * (`ratel-ai/ratel` `src/telemetry/CONVENTIONS.md`), so no span matches today.
 */
export const SDK_AGENT_KEYS = ["ratel.agent.id", "ratel.agent.name"] as const;

const INVOKE_AGENT = "invoke_agent";
const MAX_ID = 256;

/** The agent named by the export: an agent attribute up the span, else the nearest `invoke_agent` ancestor's span name. */
export function namedAgentOf(
  span: DecodedSpan,
  index: ReadonlyMap<string, DecodedSpan>,
): SpanAgent | null {
  const named = resolveUp(span, index, AGENT_KEYS);
  if (named) return { name: named.slice(0, MAX_ID), source: "attribute" };
  const invoker = ancestorsOf(span, index).find(isInvokeAgent);
  return invoker ? { name: invoker.name.slice(0, MAX_ID), source: "invoke_agent" } : null;
}

/**
 * The agent's entity key. The first rule that gives a usable key wins:
 *
 * 1. the Ratel SDK's agent field (`sdk`);
 * 2. `gen_ai.agent.name`, `gen_ai.agent.id`, `agent.name` (`semconv`);
 * 3. a framework's agent span (`semconv` for its attribute, `heuristic` for its span name);
 * 4. the nearest `invoke_agent` span, the span itself included: its name without the operation (`heuristic`);
 * 5. the resource's `service.name` (`heuristic`), unless `serviceIsAgent` is false.
 *
 * `lineage` is the span, then the ancestors it may read, nearest first. Rules
 * 1 and 2 read the lineage, then the resource. `serviceIsAgent` is false for
 * the spans of an MCP server: its service is a server, not an agent.
 */
export function agentKeyOf(
  lineage: readonly DecodedSpan[],
  { serviceIsAgent }: { serviceIsAgent: boolean },
): AgentKey | null {
  const span = lineage[0];
  if (!span) return null;
  const sdk = entityKey(firstUp(lineage, SDK_AGENT_KEYS));
  if (sdk) return { key: sdk, source: "sdk" };
  const semconv = entityKey(firstUp(lineage, AGENT_KEYS));
  if (semconv) return { key: semconv, source: "semconv" };
  for (const candidate of lineage) {
    const framework = frameworkAgentOf(candidate);
    if (framework) return framework;
  }
  for (const candidate of lineage) {
    const key = isInvokeAgent(candidate) ? entityKey(invokedAgentName(candidate.name)) : null;
    if (key) return { key, source: "heuristic" };
  }
  const service = serviceIsAgent
    ? entityKey(attrString(span.resourceAttributes, "service.name"))
    : null;
  return service ? { key: service, source: "heuristic" } : null;
}

/** The first of `keys` on the lineage, nearest first, then on the span's resource. */
function firstUp(lineage: readonly DecodedSpan[], keys: readonly string[]): string | undefined {
  for (const candidate of lineage) {
    const found = firstString(candidate.attributes, keys);
    if (found) return found;
  }
  return lineage[0] ? firstString(lineage[0].resourceAttributes, keys) : undefined;
}

function isInvokeAgent(span: DecodedSpan): boolean {
  return attrString(span.attributes, GEN_AI.operationName) === INVOKE_AGENT;
}

/** `invoke_agent researcher` names `researcher`; a bare `invoke_agent` names no agent. */
function invokedAgentName(spanName: string): string {
  const name = spanName.trim();
  if (name === INVOKE_AGENT) return "";
  return name.startsWith(`${INVOKE_AGENT} `) ? name.slice(INVOKE_AGENT.length + 1) : name;
}

/**
 * A span a framework marks as an agent: OpenLLMetry's `traceloop.span.kind =
 * agent` names it in `traceloop.entity.name`; OpenInference's
 * `openinference.span.kind = AGENT` names it in the span name.
 */
function frameworkAgentOf(span: DecodedSpan): AgentKey | null {
  if (attrString(span.attributes, "traceloop.span.kind")?.toLowerCase() === "agent") {
    const key = entityKey(firstString(span.attributes, ["traceloop.entity.name"]));
    if (key) return { key, source: "semconv" };
  }
  if (attrString(span.attributes, "openinference.span.kind")?.toLowerCase() === "agent") {
    const key = entityKey(span.name);
    if (key) return { key, source: "heuristic" };
  }
  return null;
}
