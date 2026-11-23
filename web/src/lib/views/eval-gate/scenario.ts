import type { CloudMessage, ContentBlock } from "@/lib/ingest/cloud-schema";
import type { ModelCall } from "./calls";
import type { ReplayCall, ReplayMessage } from "./models";
import type { InvokeStep, RunRecord, ToolDef } from "./types";

/**
 * The replay's scenario (RC-607): what the model sees when a run is replayed
 * (system prompt, earlier messages, the ask, the tools it is offered) and the
 * tool results the replay already knows. One seam builds it, so a later
 * adapter can fill what the recording lacks from the eval's own spec.
 *
 * `recordedScenario` is today's adapter: the run's captured model-call
 * payloads, with an eval's earlier messages around them. It returns null when
 * the prompts weren't captured; the replay refuses on null.
 */

export interface RecordedCall extends ReplayCall {
  result: string;
  isError: boolean;
}

export interface Recording {
  /** The conversation before the run's first decision. */
  history: ReplayMessage[];
  system: string | undefined;
  /** Every tool the run was offered, deduped by name. */
  tools: ToolDef[];
  /** The calls the run made, with their recorded results. */
  calls: RecordedCall[];
  /** RC-76: calls the conversation made and answered before the run (earlier turns): a replay that repeats one gets the same answer. */
  earlier: RecordedCall[];
  model: string | null;
  /** Mean recorded tool time per call, for the replay's time. */
  toolMs: number;
  /** The most input tokens one of the run's model calls recorded (0 when none did): the floor of a replay call's estimate. */
  inputTokens: number;
  /**
   * RC-609: the inputs a spec-backed scenario took from the eval, not the
   * recording (`systemPrompt`, `message`, `tools`, `earlierMessages`, `context`). Absent on
   * a recorded scenario. When present, the eval's context grounds the IDs, so
   * the replay doesn't refuse a first call whose IDs the recording never shows.
   */
  filled?: readonly string[];
  /** RC-609: named values the eval gives the model and the tool stand-in (a booking reference). */
  context?: Readonly<Record<string, string>>;
}

/**
 * What a scenario is built from: the run, its model calls and what an eval
 * adds. RC-295: `history` goes before the recorded conversation; RC-296:
 * `after` goes after it (earlier turns of this replay and the next message).
 */
export interface ScenarioRequest {
  run: RunRecord;
  calls: readonly ModelCall[];
  history?: readonly ReplayMessage[];
  after?: readonly ReplayMessage[];
}

/** The port: the scenario a replay runs, or null when nothing can be built. */
export type ScenarioBuilder = (request: ScenarioRequest) => Recording | null;

/** The recorded adapter: the captured conversation, with the eval's messages around it. Null when the prompts weren't captured. */
export const recordedScenario: ScenarioBuilder = ({ run, calls, history = [], after = [] }) => {
  const recording = readRecording(run, calls);
  return recording && withEarlier(recording, history, after);
};

/**
 * The run's recording from its model calls, or null when its prompts weren't
 * captured. The last call's messages hold the whole conversation: everything
 * after the first call's input is what the run did.
 */
export function readRecording(run: RunRecord, calls: readonly ModelCall[]): Recording | null {
  const points = calls.filter((call) => call.payload && captured(call));
  if (points.length === 0) return null;
  const first = points[0]!.payload!;
  const last = points[points.length - 1]!.payload!;
  const historyLength = Math.max(0, first.messages.length - 1);
  const history = toReplayMessages(first.messages.slice(0, historyLength));
  const after = toReplayMessages(last.messages.slice(historyLength));
  const results = new Map(
    after
      .filter(
        (message): message is Extract<ReplayMessage, { role: "tool" }> => message.role === "tool",
      )
      .map((message) => [message.callId, message]),
  );
  const invokes = run.steps.filter((step): step is InvokeStep => step.kind === "invoke");
  const recordedCalls: RecordedCall[] = [];
  for (const message of after) {
    if (message.role !== "assistant") continue;
    for (const call of message.calls) {
      const result = results.get(call.id);
      if (!result) continue;
      const step = invokes[recordedCalls.length];
      const failed =
        step && step.targetId === call.name ? step.outcome === "error" : result.isError;
      recordedCalls.push({ ...call, result: result.content, isError: failed || result.isError });
    }
  }
  const tools = new Map<string, ToolDef>();
  for (const point of points) {
    for (const tool of point.payload!.tools ?? []) {
      if (!tools.has(tool.name))
        tools.set(tool.name, {
          name: tool.name,
          description: tool.description ?? "",
          parameters: tool.parameters ?? { type: "object", properties: {} },
        });
    }
  }
  const earlier = answeredCalls(history);
  const modelMs = points.reduce((sum, call) => sum + (call.latencyMs ?? 0), 0);
  const toolMs =
    recordedCalls.length > 0 && run.durationMs
      ? Math.max(0, (run.durationMs - modelMs) / recordedCalls.length)
      : 0;
  const inputTokens = Math.max(0, ...points.map((call) => call.inputTokens ?? 0));
  return {
    history,
    system: first.system,
    tools: [...tools.values()],
    calls: recordedCalls,
    earlier,
    model: points[0]!.model ?? first.model ?? null,
    toolMs,
    inputTokens,
  };
}

/** Recorded messages as the replay keeps them. A tool result says whether it failed (an `error` field). */
export function toReplayMessages(messages: readonly CloudMessage[]): ReplayMessage[] {
  return messages.flatMap((message): ReplayMessage[] => {
    if (message.role === "tool")
      return [
        {
          role: "tool",
          callId: message.tool_call_id,
          content: String(message.content ?? ""),
          isError: looksFailed(String(message.content ?? "")),
        },
      ];
    const blocks = blocksOf(message.content);
    if (message.role === "user") return [{ role: "user", text: textOf(blocks) }];
    const calls = blocks
      .filter(
        (block): block is Extract<ContentBlock, { type: "tool_call" }> =>
          block.type === "tool_call" && typeof block.name === "string",
      )
      .map((block) => ({
        id: String(block.id ?? ""),
        name: block.name,
        args: block.arguments && typeof block.arguments === "object" ? block.arguments : {},
      }));
    return [{ role: "assistant", text: textOf(blocks), calls }];
  });
}

/** A recorded tool result that reports a failure: a JSON object with an `error` field. */
export function looksFailed(content: string): boolean {
  try {
    const value = JSON.parse(content) as unknown;
    return !!value && typeof value === "object" && !Array.isArray(value) && "error" in value;
  } catch {
    return false;
  }
}

/**
 * RC-295: the recording with `history` before its own and (RC-296) `after`
 * after it. Calls answered in them count as earlier ones (a re-read gets the
 * same answer, and isn't held to the recorded path).
 */
function withEarlier(
  recording: Recording,
  history: readonly ReplayMessage[],
  after: readonly ReplayMessage[],
): Recording {
  if (history.length === 0 && after.length === 0) return recording;
  return {
    ...recording,
    history: [...history, ...recording.history, ...after],
    earlier: [...answeredCalls(history), ...recording.earlier, ...answeredCalls(after)],
  };
}

function captured(call: ModelCall): boolean {
  const messages = call.payload?.messages ?? [];
  return (
    messages.length >= 2 ||
    messages.some(
      (message) => message.role !== "tool" && textOf(blocksOf(message.content)).trim().length > 0,
    )
  );
}

/** The calls `messages` made that have a result in them. */
export function answeredCalls(messages: readonly ReplayMessage[]): RecordedCall[] {
  const results = new Map(
    messages
      .filter(
        (message): message is Extract<ReplayMessage, { role: "tool" }> => message.role === "tool",
      )
      .map((message) => [message.callId, message]),
  );
  return messages.flatMap((message) =>
    message.role !== "assistant"
      ? []
      : message.calls.flatMap((call) => {
          const result = results.get(call.id);
          return result ? [{ ...call, result: result.content, isError: result.isError }] : [];
        }),
  );
}

function blocksOf(content: CloudMessage["content"]): ContentBlock[] {
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : Array.isArray(content)
      ? content
      : [];
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(
      (block): block is Extract<ContentBlock, { type: "text" }> =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}
