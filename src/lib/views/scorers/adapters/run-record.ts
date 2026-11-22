import type { ModelCall } from "@/lib/views/eval-gate/calls";
import type { ReplayMessage } from "@/lib/views/eval-gate/models";
import { toReplayMessages } from "@/lib/views/eval-gate/scenario";
import { recordedView } from "@/lib/views/eval-gate/simulate";
import type { RunRecord as TraceRun } from "@/lib/views/eval-gate/types";
import type { RunMessage, RunRecord, RunToolCall } from "../domain/types";
import { recordFromLegacyRun } from "./legacy";

/**
 * Run records from what Cloud has: a live run's trace with its model calls
 * (the score job), or an eval's replayed conversation (eval runs). Text is
 * present only when the run's prompts were captured.
 */

export interface RecordMeasures {
  latencyMs: number | null;
  costUsd: number | null;
  answered?: boolean | null;
  tokens?: RunRecord["tokens"];
}

/** A live task run: the ledger's calls and measures, with the captured conversation when there is one. */
export function recordFromTrace(run: TraceRun, calls: readonly ModelCall[]): RunRecord {
  const base = recordFromLegacyRun(recordedView(run));
  const tokens = tokensOf(calls);
  const last = [...calls]
    .reverse()
    .find((call) => call.payload && call.payload.messages.length > 0)?.payload;
  if (!last) return { ...base, tokens };
  const messages = toReplayMessages([...last.messages, ...(last.output ?? [])]);
  const conversation = recordFromConversation(
    messages,
    { latencyMs: base.latencyMs, costUsd: base.costUsd, answered: base.answered, tokens },
    last.system,
  );
  // The ledger's outcomes win: they are what the rest of the product reads.
  const toolCalls =
    base.toolCalls && conversation.toolCalls
      ? base.toolCalls.map((call, index) => {
          const said = conversation.toolCalls![index];
          return said && said.name === call.name ? { ...said, outcome: call.outcome } : call;
        })
      : base.toolCalls;
  return {
    ...base,
    messages: conversation.messages,
    toolCalls,
    finalAnswer: conversation.finalAnswer,
    tokens,
  };
}

/** A conversation as a run record. Tool results are parsed as JSON when they are JSON. */
export function recordFromConversation(
  messages: readonly ReplayMessage[],
  measures: RecordMeasures,
  system?: string,
): RunRecord {
  const results = new Map(
    messages.flatMap((message) =>
      message.role === "tool" ? [[message.callId, message] as const] : [],
    ),
  );
  const runMessages: RunMessage[] = system ? [{ role: "system", content: system }] : [];
  const toolCalls: RunToolCall[] = [];
  for (const message of messages) {
    if (message.role === "user") runMessages.push({ role: "user", content: message.text });
    else if (message.role === "tool") runMessages.push({ role: "tool", content: message.content });
    else {
      if (message.text) runMessages.push({ role: "assistant", content: message.text });
      for (const call of message.calls) {
        const result = results.get(call.id);
        toolCalls.push({
          name: call.name,
          arguments: call.args,
          result: result ? parsed(result.content) : null,
          outcome: result ? (result.isError ? "error" : "ok") : "unknown",
          latencyMs: null,
        });
      }
    }
  }
  const lastMessage = messages.at(-1);
  const finalAnswer =
    lastMessage?.role === "assistant" && lastMessage.calls.length === 0 && lastMessage.text
      ? lastMessage.text
      : null;
  return {
    messages: runMessages,
    toolCalls,
    finalAnswer,
    answered: measures.answered ?? (finalAnswer === null ? null : true),
    latencyMs: measures.latencyMs,
    costUsd: measures.costUsd,
    tokens: measures.tokens ?? null,
  };
}

function tokensOf(calls: readonly ModelCall[]): RunRecord["tokens"] {
  const known = calls.filter((call) => call.inputTokens !== null || call.outputTokens !== null);
  if (known.length === 0) return null;
  return {
    input: known.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0),
    output: known.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0),
  };
}

function parsed(content: string): unknown {
  const text = content.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return content;
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON after all: scorers read the text as it is.
    return content;
  }
}
