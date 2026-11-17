/**
 * One model call for the context inspector (RC-284, A6, A7): its stored
 * payload read into sections (system prompt, skills, tools, messages, what
 * came back, settings), what changed since the call before it, and a tool
 * step's arguments and result. Pure: `inspect-load.ts` reads the payloads,
 * and only with the content opt-in on.
 */

export interface InspectToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface InspectMessage {
  role: string;
  text: string;
  toolCalls: InspectToolCall[];
  /** A tool result's call id. */
  toolCallId: string | null;
}

export interface InspectTool {
  name: string;
  description: string | null;
  parameters: unknown;
}

export interface CallView {
  system: string | null;
  /** Skill names found in the system prompt's skill blocks. */
  skills: string[];
  tools: InspectTool[];
  /** The call's input messages. */
  messages: InspectMessage[];
  /** What came back: the stored output (RC-280), else the messages after the input. */
  output: InspectMessage[];
  /** The stored settings (RC-280), else the older `params`. */
  settings: Record<string, unknown> | null;
}

export type ToolTag = "called_here" | "never_called" | "new";

export interface CallDiff {
  firstCall: boolean;
  /** Indexes into the call's input messages that the call before it did not have. */
  newMessages: number[];
  toolsAdded: string[];
  toolsRemoved: string[];
  tools: { name: string; tags: ToolTag[] }[];
  summary: string;
}

const SKILL_NAME = /<skill\s+[^>]*name=["']([^"']+)["']/gi;

export function parseCallPayload(payload: unknown): CallView {
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const all = Array.isArray(p.messages) ? p.messages : [];
  const split =
    typeof p.input_message_count === "number" &&
    p.input_message_count >= 0 &&
    p.input_message_count <= all.length
      ? p.input_message_count
      : trailingAssistantStart(all);
  const system = typeof p.system === "string" && p.system !== "" ? p.system : null;
  return {
    system,
    skills: system ? [...new Set([...system.matchAll(SKILL_NAME)].map((m) => m[1]!))] : [],
    tools: (Array.isArray(p.tools) ? p.tools : []).flatMap((raw) => {
      const t = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      return typeof t.name === "string"
        ? [
            {
              name: t.name,
              description: typeof t.description === "string" ? t.description : null,
              parameters: t.parameters ?? null,
            },
          ]
        : [];
    }),
    messages: all.slice(0, split).map(toMessage),
    output: (Array.isArray(p.output) ? p.output : all.slice(split)).map(toMessage),
    settings: asRecord(p.settings) ?? asRecord(p.params),
  };
}

/** What changed from `previous` (null for a session's first call) to `current`. `sessionCalled`: every tool the session called. */
export function callDiff(
  previous: CallView | null,
  current: CallView,
  sessionCalled: ReadonlySet<string>,
): CallDiff {
  const before = previous ? [...previous.messages, ...previous.output].map(messageKey) : [];
  let shared = 0;
  while (
    shared < current.messages.length &&
    shared < before.length &&
    messageKey(current.messages[shared]!) === before[shared]
  )
    shared += 1;
  const newMessages = current.messages.map((_, i) => i).filter((i) => i >= shared);
  const hadTools = new Set(previous?.tools.map((t) => t.name) ?? []);
  const hasTools = new Set(current.tools.map((t) => t.name));
  const calledHere = new Set(current.output.flatMap((m) => m.toolCalls.map((c) => c.name)));
  const toolsAdded = current.tools.map((t) => t.name).filter((name) => !hadTools.has(name));
  const toolsRemoved = previous
    ? previous.tools.map((t) => t.name).filter((name) => !hasTools.has(name))
    : [];
  const tools = current.tools.map(({ name }) => {
    const tags: ToolTag[] = [];
    if (calledHere.has(name)) tags.push("called_here");
    else if (!sessionCalled.has(name)) tags.push("never_called");
    if (!hadTools.has(name)) tags.push("new");
    return { name, tags };
  });
  return {
    firstCall: previous === null,
    newMessages,
    toolsAdded,
    toolsRemoved,
    tools,
    summary: diffSummary(previous === null, newMessages.length, toolsAdded, toolsRemoved),
  };
}

/** A tool step's arguments, from the call that chose it, and its result, from the call after it. Null where not stored. */
export function toolStepContent(
  toolName: string,
  chooser: CallView | null,
  after: CallView | null,
): { arguments: unknown; result: string | null } {
  const chosen =
    chooser?.output
      .flatMap((m) => m.toolCalls)
      .filter((c) => c.name === toolName)
      .at(-1) ?? null;
  const results = after?.messages.filter((m) => m.role === "tool") ?? [];
  const result = chosen?.id ? results.find((m) => m.toolCallId === chosen.id) : undefined;
  return { arguments: chosen ? chosen.arguments : null, result: result?.text ?? null };
}

function diffSummary(first: boolean, added: number, toolsIn: string[], toolsOut: string[]): string {
  if (first) return "The session's first call";
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added} ${added === 1 ? "message" : "messages"}`);
  if (toolsIn.length > 0) parts.push(`tools in: ${toolsIn.join(", ")}`);
  if (toolsOut.length > 0) parts.push(`tools out: ${toolsOut.join(", ")}`);
  return parts.length > 0 ? parts.join(" · ") : "No change since the last call";
}

function toMessage(raw: unknown): InspectMessage {
  const m = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const content = m.content;
  const blocks = Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
  return {
    role: typeof m.role === "string" ? m.role : "unknown",
    text:
      typeof content === "string"
        ? content
        : blocks
            .filter((b) => b?.type === "text" && typeof b.text === "string")
            .map((b) => b.text as string)
            .join("\n"),
    toolCalls: blocks
      .filter((b) => b?.type === "tool_call" && typeof b.name === "string")
      .map((b) => ({
        id: typeof b.id === "string" ? b.id : "",
        name: b.name as string,
        arguments: b.arguments ?? null,
      })),
    toolCallId: typeof m.tool_call_id === "string" ? m.tool_call_id : null,
  };
}

function messageKey(message: InspectMessage): string {
  return JSON.stringify(message);
}

function trailingAssistantStart(messages: readonly unknown[]): number {
  let i = messages.length;
  while (i > 0 && (messages[i - 1] as { role?: unknown } | null)?.role === "assistant") i -= 1;
  return i;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
