/**
 * Plain names for what a span did (DESIGN.md, Plain language). A span class or
 * an OpenTelemetry operation name is a specialist's word; a step in a run is a
 * "Model call", a "Tool call", a "Search" or an "Agent step". Raw names stay in
 * the Details tab.
 */

export type StepKind = "model" | "tool" | "search" | "agent" | "step";

export const STEP_KIND_LABEL: Readonly<Record<StepKind, string>> = {
  model: "Model call",
  tool: "Tool call",
  search: "Search",
  agent: "Agent step",
  step: "Step",
};

/** The fields a span needs to be named. Every v2 span shape satisfies it. */
export interface NamedSpan {
  name: string;
  spanClass: string;
  operationName?: string | null;
  model?: string | null;
  searchQuery?: string | null;
  searchTarget?: string | null;
  attributes?: Readonly<Record<string, unknown>>;
}

const AGENT_OPERATIONS = new Set(["invoke_agent", "create_agent"]);
/** GenAI semantic-convention span names are "<operation> <target>". */
const OPERATION_PREFIX =
  /^(?:chat|text_completion|generate_content|embeddings|execute_tool|invoke_agent|create_agent)\s+(\S.*)$/;
const AGENT_NAME = /^(?:invoke_agent|create_agent)\b|^agent(?:$|[._\s-])/i;

export function stepKind(span: NamedSpan): StepKind {
  if (span.spanClass === "llm_call") return "model";
  if (span.spanClass === "tool") return "tool";
  if (span.spanClass === "ratel_search") return "search";
  const operation = span.operationName ?? stringAttribute(span.attributes, "gen_ai.operation.name");
  if (
    (operation && AGENT_OPERATIONS.has(operation)) ||
    stringAttribute(span.attributes, "gen_ai.agent.name") ||
    AGENT_NAME.test(span.name)
  ) {
    return "agent";
  }
  return "step";
}

export function stepKindLabel(span: NamedSpan): string {
  return STEP_KIND_LABEL[stepKind(span)];
}

/**
 * What the step was about, in the reader's words: the model for a model call,
 * the tool for a tool call, the query for a search, the agent for an agent
 * step. Falls back to the span name without its operation prefix.
 */
export function stepTitle(span: NamedSpan): string {
  switch (stepKind(span)) {
    case "model":
      return clean(span.model) ?? humanSpanName(span.name);
    case "tool":
      return (
        clean(stringAttribute(span.attributes, "gen_ai.tool.name")) ??
        toolNameFromSpanName(span.name)
      );
    case "search": {
      const query = clean(span.searchQuery);
      if (query) return `“${query}”`;
      const target = clean(span.searchTarget);
      return target ? `Searched ${target}` : humanSpanName(span.name);
    }
    case "agent":
      return (
        clean(stringAttribute(span.attributes, "gen_ai.agent.name")) ?? humanSpanName(span.name)
      );
    case "step":
      return span.name;
  }
}

/** "invoke_agent support-agent" reads as "support-agent"; other names stay. */
export function humanSpanName(name: string): string {
  const match = OPERATION_PREFIX.exec(name.trim());
  return match ? match[1].trim() : name;
}

/** A tool span without `gen_ai.tool.name`: "execute_tool lookup_order", "tool.ripgrep". */
export function toolNameFromSpanName(name: string): string {
  const human = humanSpanName(name);
  return human.startsWith("tool.") && human.length > 5 ? human.slice(5) : human;
}

export function stringAttribute(
  attributes: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | null {
  const value = attributes?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clean(value: string | null | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
}
