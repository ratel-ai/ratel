import type { CloudEvent } from "@/lib/ingest/cloud-schema";
import { toReplayMessages } from "@/lib/views/eval-gate/scenario";
import { argsKey } from "../fakes/domain/fake";

/**
 * The replay source of a recorded chat session (RC-1109, spec §9): the
 * session's user messages in order, one per turn, and the tool calls each
 * turn made with their recorded results. The playground sends one user
 * message per run, and the fake service answers a faked call from the
 * recorded calls (step 2 of the fake order, `replay.sourceSessionId`).
 *
 * A sandbox run is a normal session with the step kinds of
 * `spec-workflows-first-class.md` (user_message, model_call, tool_call):
 * this module only reads a recorded session. It adds no step model.
 *
 * Pure rules here. `pg-session-source.ts` reads the rows.
 */

export interface RecordedToolCall {
  tool: string;
  args: unknown;
  result: unknown;
  isError: boolean;
}

export interface ReplayTurn {
  turnIndex: number;
  traceId: string;
  /** The person's message of this turn: what the replay sends as one run. */
  userMessage: string;
  /** The turn's tool calls in time order, with the recorded results. */
  toolCalls: RecordedToolCall[];
}

export interface ReplaySource {
  replayable: true;
  sessionId: string;
  turns: ReplayTurn[];
  /** `ratel.sandbox.id` on the session's root spans, when production stamped it. */
  sandboxId: string | null;
  /** `gen_ai.agent.name` on the session's root spans: the fallback sandbox match. */
  agentName: string | null;
}

export type NotReplayableReason = "no_session" | "content_off" | "no_message_content";

export interface NotReplayable {
  replayable: false;
  sessionId: string;
  reason: NotReplayableReason;
  /** A sentence for the session page: why this session cannot replay. */
  message: string;
}

export type ReplaySourceResult = ReplaySource | NotReplayable;

/** One recorded span of a turn's trace, as the adapter reads it. */
export interface SourceSpan {
  spanId: string;
  parentSpanId: string | null;
  startedAt: Date;
  operation: string | null;
  statusCode: number;
  attributes: Readonly<Record<string, unknown>>;
}

/** One turn of the session as stored: its traces' spans and the model-call payloads by span id. */
export interface SourceTurn {
  traceIds: readonly string[];
  spans: readonly SourceSpan[];
  /** ADR-0013 model-call payloads (`events.payload`), by span id. */
  payloads: ReadonlyMap<string, CloudEvent | null>;
}

export interface SandboxMatch {
  sandboxId: string;
  by: "sandbox_id" | "agent_name";
}

/** Where a replayed turn left the recorded path. */
export interface TurnPath {
  diverged: boolean;
  /** The first replayed call that is off the path; null when the turn is on it. */
  firstOffPath: number | null;
}

export const NOT_REPLAYABLE_MESSAGES: Record<NotReplayableReason, string> = {
  no_session: "This session has no finished turn to replay.",
  content_off:
    "Replay needs the message text, and this project does not keep it. Turn on message content in the project settings.",
  no_message_content:
    "Replay needs the user messages, and this session recorded none. The agent sent its traces without message content.",
};

const SANDBOX_ID = "ratel.sandbox.id";
const AGENT_NAME = "gen_ai.agent.name";
const TOOL_NAME = "gen_ai.tool.name";
const TOOL_ARGS = "gen_ai.tool.call.arguments";
const TOOL_RESULT = "gen_ai.tool.call.result";
const EXECUTE_TOOL = "execute_tool";
const STATUS_ERROR = 2;

/**
 * The replay source of a session from its stored turns (in time order), or
 * not replayable with the reason. `readContent` is the project's content
 * opt-in: off, no message text is read, so the session cannot replay.
 */
export function buildReplaySource(
  sessionId: string,
  turns: readonly SourceTurn[],
  { readContent }: { readContent: boolean },
): ReplaySourceResult {
  if (turns.length === 0) return notReplayable(sessionId, "no_session");
  if (!readContent) return notReplayable(sessionId, "content_off");
  const replayTurns: ReplayTurn[] = [];
  for (const turn of turns) {
    const userMessage = turnUserMessage(turn);
    // A turn with no recorded ask (a tool-only run, a lost payload) is not a turn the replay can send.
    if (!userMessage) continue;
    replayTurns.push({
      turnIndex: replayTurns.length,
      traceId: turn.traceIds[0] ?? "",
      userMessage,
      toolCalls: turnToolCalls(turn.spans),
    });
  }
  if (replayTurns.length === 0) return notReplayable(sessionId, "no_message_content");
  const roots = turns.flatMap((turn) => turn.spans.filter((span) => span.parentSpanId === null));
  return {
    replayable: true,
    sessionId,
    turns: replayTurns,
    sandboxId: firstString(roots, SANDBOX_ID),
    agentName: firstString(roots, AGENT_NAME),
  };
}

/**
 * The sandbox a session replays in: `ratel.sandbox.id` when the runner has that
 * sandbox, else the sandbox whose id equals the agent name. Null when neither is in
 * the runner's manifest.
 */
export function matchSandbox(
  source: Pick<ReplaySource, "sandboxId" | "agentName">,
  manifestSandboxIds: readonly string[],
): SandboxMatch | null {
  const ids = new Set(manifestSandboxIds);
  if (source.sandboxId && ids.has(source.sandboxId))
    return { sandboxId: source.sandboxId, by: "sandbox_id" };
  if (source.agentName && ids.has(source.agentName))
    return { sandboxId: source.agentName, by: "agent_name" };
  return null;
}

/**
 * Whether a replayed turn stayed on the recorded path: its tool calls, by
 * tool name and normalized arguments, must be a prefix of the recorded
 * turn's calls. A call the recording does not have at that place diverges.
 */
export function turnPath(
  recorded: readonly Pick<RecordedToolCall, "tool" | "args">[],
  replayed: readonly Pick<RecordedToolCall, "tool" | "args">[],
): TurnPath {
  for (let i = 0; i < replayed.length; i += 1) {
    const want = recorded[i];
    const got = replayed[i]!;
    if (!want || want.tool !== got.tool || argsKey(want.args) !== argsKey(normalizeArgs(got.args)))
      return { diverged: true, firstOffPath: i };
  }
  return { diverged: false, firstOffPath: null };
}

/**
 * The turn's ask: the last user message of its first model call's input. The
 * extraction is the eval-gate scenario's (`toReplayMessages`), so a replay
 * and a what-if read the same text.
 */
function turnUserMessage(turn: SourceTurn): string | null {
  const calls = turn.spans
    .filter((span) => turn.payloads.get(span.spanId)?.messages?.length)
    .sort(
      (a, b) => a.startedAt.getTime() - b.startedAt.getTime() || (a.spanId < b.spanId ? -1 : 1),
    );
  for (const call of calls) {
    const payload = turn.payloads.get(call.spanId)!;
    const input =
      payload.input_message_count === undefined
        ? payload.messages
        : payload.messages.slice(0, payload.input_message_count);
    const asks = toReplayMessages(input).filter(
      (message): message is Extract<typeof message, { role: "user" }> => message.role === "user",
    );
    const text = asks[asks.length - 1]?.text.trim();
    if (text) return text;
  }
  return null;
}

/**
 * The turn's `execute_tool` spans in time order. A framework span of a call
 * (the AI SDK's `ai.toolCall`) can hold a runner's span of the same call: only
 * the outer one counts, so a call is never counted twice.
 */
function turnToolCalls(spans: readonly SourceSpan[]): RecordedToolCall[] {
  const tools = spans.filter(
    (span) => span.operation === EXECUTE_TOOL && typeof span.attributes[TOOL_NAME] === "string",
  );
  const toolSpanIds = new Set(tools.map((span) => span.spanId));
  return tools
    .filter((span) => !(span.parentSpanId && toolSpanIds.has(span.parentSpanId)))
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || (a.spanId < b.spanId ? -1 : 1))
    .map((span) => ({
      tool: span.attributes[TOOL_NAME] as string,
      args: parseJson(span.attributes[TOOL_ARGS]),
      result: parseJson(span.attributes[TOOL_RESULT]),
      isError: span.statusCode === STATUS_ERROR,
    }));
}

function notReplayable(sessionId: string, reason: NotReplayableReason): NotReplayable {
  return { replayable: false, sessionId, reason, message: NOT_REPLAYABLE_MESSAGES[reason] };
}

function firstString(spans: readonly SourceSpan[], key: string): string | null {
  const sorted = [...spans].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  for (const span of sorted) {
    const value = span.attributes[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/** Recorded arguments are a JSON string on the span; replayed ones may be either. */
function normalizeArgs(args: unknown): unknown {
  return parseJson(args);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // Not JSON: the value is plain text.
    return value;
  }
}
