import type { ToolAnswerReason, ToolAnswerSource } from "@/lib/views/eval-gate/types";
import { parseCallPayload } from "@/lib/views/session-chat/inspect";
import type { StepContent, StoredCall } from "@/lib/views/session-chat/inspect-load";
import {
  buildSessionChat,
  type ChatCallText,
  type SessionChat,
} from "@/lib/views/session-chat/model";
import type { StepContentSource } from "@/lib/views/session-chat/panel-client";
import {
  buildSessionTimeline,
  type TimelineLedgerStep,
  type TimelineModelCall,
  type TimelineTurn,
} from "@/lib/views/session-replay/timeline";
import { differStep, type ReplayStepView, replaySteps } from "./steps";
import type { Eval, EvalResult, EvalSpecField } from "./types";

/**
 * RC-647: one eval run as the session replay renders it. The run's transcript
 * becomes the `SessionChat` of a Traces session (each model step a model call,
 * each tool answer a tool call, one turn per message), and the text the
 * inspector shows (system prompt, each call's input and output) comes from
 * memory through {@link evalStepSource} instead of the trace tables. Pure.
 *
 * The transcript keeps no time per model step: the tool steps take their
 * answer's ms, and the model steps share the rest of the run's duration.
 */

export type EvalChatItem = Pick<
  Eval,
  "systemPrompt" | "message" | "earlierMessages" | "tools" | "generated"
>;
export type EvalChatResult = Pick<
  EvalResult,
  | "id"
  | "transcript"
  | "toolAnswers"
  | "turns"
  | "durationMs"
  | "costUsd"
  | "generated"
  | "createdAt"
>;

/** Where one tool answer came from (the replay engine's decision). */
export interface EvalStepAnswer {
  source: ToolAnswerSource;
  reason: ToolAnswerReason;
  why?: string;
}

/** One chat step's place in the transcript, for the eval's own actions. */
export interface EvalChatStep {
  /** The step's index in `transcript.steps` (what the step actions take). */
  transcriptIndex: number;
  role: "assistant" | "tool";
  /** A tool step's answer source; null when the run did not record it. */
  answer: EvalStepAnswer | null;
}

export interface EvalChat {
  chat: SessionChat;
  /** By chat step index: the model and tool steps. */
  steps: Record<number, EvalChatStep>;
  /** The inspector's text, by the chat's model call event id. */
  content: StepContent;
  /** The spec fields a model wrote that this run used (the Generated mark). */
  generated: EvalSpecField[];
  /** The chat step where this run starts to differ from the previous one; null when it does not, or there is none. */
  differsAt: number | null;
}

/** A payload message, in the shape `parseCallPayload` reads. */
type PayloadMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: (
        | { type: "text"; text: string }
        | { type: "tool_call"; id: string; name: string; arguments: unknown }
      )[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

/** Null when the result kept no text (expired, or from before RC-641). */
export function evalChat(
  item: EvalChatItem,
  result: EvalChatResult,
  previous: Pick<EvalResult, "transcript" | "toolAnswers"> | null = null,
): EvalChat | null {
  if (!result.transcript) return null;
  const views = replaySteps(result.transcript, result.toolAnswers);
  const groups = turnGroups(
    views,
    (result.turns ?? []).map((turn) => turn.answers),
  );
  const assistantCount = views.filter((view) => view.role === "assistant").length;
  const toolMs = result.toolAnswers.reduce((sum, answer) => sum + (answer.ms ?? 0), 0);
  const callMs =
    result.durationMs !== null && assistantCount > 0
      ? Math.max(0, result.durationMs - toolMs) / assistantCount
      : null;
  const callCost =
    result.costUsd !== null && assistantCount > 0 ? result.costUsd / assistantCount : null;
  const eventId = (index: number) => `${result.id}:step:${index}`;

  const origin = result.createdAt.getTime() - (result.durationMs ?? 0);
  const system = item.systemPrompt ?? null;
  const tools =
    item.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) ??
    result.transcript.toolsOffered.map((name) => ({ name }));
  const history: PayloadMessage[] = earlierPayload(item.earlierMessages);
  const pending: { id: string; name: string }[] = [];
  const timelineTurns: TimelineTurn[] = [];
  const modelCalls: TimelineModelCall[] = [];
  const texts = new Map<string, ChatCallText>();
  const calls: Record<string, StoredCall> = {};
  let cursor = origin;
  let answered = 0;

  groups.forEach((group, turnAt) => {
    const turnId = `${result.id}:turn:${turnAt + 1}`;
    const startedAt = new Date(cursor);
    const ask = result.turns?.[turnAt]?.message ?? (turnAt === 0 ? item.message : null);
    if (ask) history.push({ role: "user", content: ask });
    const ledger: TimelineLedgerStep[] = [];
    let first = true;
    for (const view of group) {
      const at = new Date(cursor);
      if (view.role === "assistant") {
        const id = eventId(view.index);
        const output: PayloadMessage = {
          role: "assistant",
          content: [
            ...(view.text ? [{ type: "text" as const, text: view.text }] : []),
            ...view.calls.map((call, i) => ({
              type: "tool_call" as const,
              id: `${id}:call:${i}`,
              name: call.name,
              arguments: call.args,
            })),
          ],
        };
        const raw = {
          system,
          tools,
          messages: [...history, output],
          input_message_count: history.length,
        };
        calls[id] = { raw, view: parseCallPayload(raw) };
        modelCalls.push({
          eventId: id,
          turnId,
          occurredAt: at,
          model: null,
          finishReason: null,
          inputTokens: null,
          outputTokens: null,
          cachedTokens: null,
          costUsd: callCost,
          latencyMs: callMs,
          hasContent: true,
        });
        texts.set(id, { ask: first ? ask : null, reply: view.text.trim() ? view.text : null });
        first = false;
        history.push(output);
        pending.splice(
          0,
          pending.length,
          ...view.calls.map((call, i) => ({ id: `${id}:call:${i}`, name: call.name })),
        );
        cursor += Math.max(callMs ?? 0, 1);
      } else {
        const ms = result.toolAnswers[answered]?.ms ?? null;
        answered += 1;
        const match = pending.findIndex((call) => call.name === view.tool);
        const [call] = pending.splice(match >= 0 ? match : 0, 1);
        history.push({
          role: "tool",
          tool_call_id: call?.id ?? `${eventId(view.index)}:call`,
          content: view.content,
        });
        ledger.push({
          ordinal: ledger.length + 1,
          kind: "invoke",
          traceEventId: eventId(view.index),
          occurredAt: at,
          eventPresent: true,
          targetType: "tool",
          targetId: view.tool,
          outcome: view.isError ? "error" : "ok",
          tookMs: ms,
          searchType: null,
          hitCount: null,
          hitIds: null,
        });
        cursor += Math.max(ms ?? 0, 1);
      }
    }
    timelineTurns.push({
      id: turnId,
      startedAt,
      endedAt: new Date(cursor),
      endedBy: null,
      abandoned: false,
      detour: false,
      reSearchCount: 0,
      steps: ledger,
    });
  });

  const timeline = buildSessionTimeline({
    sessionId: result.id,
    turns: timelineTurns,
    modelCalls,
    selfCorrections: [],
  });
  const chat = buildSessionChat({ timeline, turns: timelineTurns, texts });
  const steps: Record<number, EvalChatStep> = {};
  const indexOf = new Map<number, number>();
  for (const step of timeline.steps) {
    const id =
      step.kind === "model_call"
        ? step.eventId
        : step.kind === "tool_call"
          ? step.traceEventId
          : null;
    const transcriptIndex = id ? Number(id.slice(id.lastIndexOf(":") + 1)) : NaN;
    if (Number.isNaN(transcriptIndex)) continue;
    const view = views[transcriptIndex]!;
    steps[step.index] = {
      transcriptIndex,
      role: view.role,
      answer:
        view.role === "tool" && view.source && view.reason
          ? { source: view.source, reason: view.reason, ...(view.why ? { why: view.why } : {}) }
          : null,
    };
    indexOf.set(transcriptIndex, step.index);
  }
  const differ = previous?.transcript
    ? differStep(replaySteps(previous.transcript, previous.toolAnswers), views)
    : null;
  return {
    chat,
    steps,
    content: { calls, query: null },
    generated: result.generated ?? [],
    differsAt: differ === null ? null : (indexOf.get(Math.min(differ, views.length - 1)) ?? null),
  };
}

/** The inspector's port over an eval chat: the asked calls from memory; one it does not have is left out. */
export function evalStepSource(evalChat: Pick<EvalChat, "content">): StepContentSource {
  return async (request) => {
    const calls: Record<string, StoredCall> = {};
    for (const id of request.eventIds) {
      const call = evalChat.content.calls[id];
      if (call) calls[id] = call;
    }
    return { ok: true, content: { calls, query: null } };
  };
}

/**
 * The transcript's steps by turn. A turn ends at the assistant step after its
 * last tool answer (its reply); with no per-turn counts, it is one turn.
 */
function turnGroups(
  views: readonly ReplayStepView[],
  answers: readonly number[],
): ReplayStepView[][] {
  if (answers.length <= 1) return [[...views]];
  const groups: ReplayStepView[][] = [[]];
  let tools = 0;
  for (const view of views) {
    groups.at(-1)!.push(view);
    if (view.role === "tool") tools += 1;
    else if (
      tools >= (answers[groups.length - 1] ?? 0) &&
      view.calls.length === 0 &&
      groups.length < answers.length
    ) {
      groups.push([]);
      tools = 0;
    }
  }
  return groups.filter((group, i) => group.length > 0 || i === 0);
}

/** The eval's earlier messages as payload messages: a tool message is its call and its answer. */
function earlierPayload(messages: Eval["earlierMessages"]): PayloadMessage[] {
  return messages.flatMap((message, i): PayloadMessage[] => {
    if (message.role === "user") return [{ role: "user", content: message.text }];
    if (message.role === "assistant")
      return [{ role: "assistant", content: [{ type: "text", text: message.text }] }];
    const id = `earlier:${i}`;
    return [
      {
        role: "assistant",
        content: [
          { type: "tool_call", id, name: message.tool ?? "tool", arguments: message.args ?? {} },
        ],
      },
      { role: "tool", tool_call_id: id, content: message.text },
    ];
  });
}
