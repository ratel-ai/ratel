import type { ReplayMessage } from "@/lib/views/eval-gate/models";
import { looksFailed, type ReplayExtras, type ToolMock } from "@/lib/views/eval-gate/replay";
import type { Eval, EvalFixedAnswer, EvalMessage } from "./domain/types";

/**
 * RC-295: what an eval adds to its replay. Its earlier messages become the
 * history before the recorded one (the agent sees them; nothing in them is
 * scored), and its fixed answers become mocks the engine checks first.
 * RC-654: its opening steps play after the ask, before the agent goes on.
 */
export function evalReplayExtras(
  item: Pick<Eval, "earlierMessages" | "fixedAnswers" | "opening">,
): ReplayExtras {
  return {
    history: earlierHistory(item.earlierMessages),
    mocks: item.fixedAnswers.map(toMock),
    ...(item.opening?.length ? { opening: item.opening } : {}),
  };
}

/** A tool message is the agent's call and the tool's answer to it. */
export function earlierHistory(messages: readonly EvalMessage[]): ReplayMessage[] {
  return messages.flatMap((message, index): ReplayMessage[] => {
    if (message.role === "user") return [{ role: "user", text: message.text }];
    if (message.role === "assistant") return [{ role: "assistant", text: message.text, calls: [] }];
    if (!message.tool) return [];
    const callId = `earlier_${index}`;
    return [
      {
        role: "assistant",
        text: "",
        calls: [{ id: callId, name: message.tool, args: message.args ?? {} }],
      },
      { role: "tool", callId, content: message.text, isError: looksFailed(message.text) },
    ];
  });
}

/** A text answer is given as written, anything else as JSON. An answer with an `error` field fails. */
export function toMock(answer: EvalFixedAnswer): ToolMock {
  const content =
    typeof answer.result === "string" ? answer.result : JSON.stringify(answer.result ?? null);
  return {
    tool: answer.tool,
    content,
    isError: looksFailed(content),
    ...(answer.when && Object.keys(answer.when).length > 0 ? { when: answer.when } : {}),
    ...(answer.why?.trim() ? { why: answer.why.trim() } : {}),
  };
}
