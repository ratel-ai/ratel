import type {
  ReplayTranscriptStep,
  ToolAnswerReason,
  ToolAnswerSource,
} from "@/lib/views/eval-gate/types";
import type { EvalFixedAnswer, EvalMessage, EvalToolAnswer, EvalTranscript } from "./types";

/**
 * RC-641: an eval run's transcript as steps a person changes. A tool step is
 * one call's answer; its call is in the assistant step before it, in order.
 * Pure.
 */

/** One call of the transcript with the answer it got. */
export interface StepCall {
  tool: string;
  args: Record<string, unknown>;
  content: string;
  isError: boolean;
}

/** One step of the replay as the run page and the MCP show it. `source` is where a tool answer came from; null when the run did not record it. */
export type ReplayStepView =
  | {
      index: number;
      role: "assistant";
      text: string;
      calls: { name: string; args: Record<string, unknown> }[];
    }
  | {
      index: number;
      role: "tool";
      tool: string;
      args: Record<string, unknown>;
      content: string;
      isError: boolean;
      source: ToolAnswerSource | null;
      reason: ToolAnswerReason | null;
      why?: string;
    };

/** The call a tool step answers, with that answer. Null when the step is not a tool step. */
export function stepCall(steps: readonly ReplayTranscriptStep[], index: number): StepCall | null {
  const step = steps[index];
  if (!step || step.role !== "tool") return null;
  let position = 0;
  for (let at = index - 1; at >= 0; at -= 1) {
    const before = steps[at]!;
    if (before.role === "tool") {
      position += 1;
      continue;
    }
    const call =
      before.calls[position]?.name === step.tool
        ? before.calls[position]
        : before.calls.find((item) => item.name === step.tool);
    return {
      tool: step.tool,
      args: call?.args ?? {},
      content: step.content,
      isError: step.isError,
    };
  }
  return { tool: step.tool, args: {}, content: step.content, isError: step.isError };
}

/**
 * The fixed answers after a person changes the answer of one call: the call's
 * tool, with its arguments as the condition. It replaces a fixed answer for
 * the same tool and arguments.
 */
export function withStepAnswer(
  fixedAnswers: readonly EvalFixedAnswer[],
  call: Pick<StepCall, "tool" | "args">,
  answer: string,
  why?: string,
): EvalFixedAnswer[] {
  const when = Object.keys(call.args).length > 0 ? call.args : undefined;
  const key = conditionKey(when);
  const kept = fixedAnswers.filter(
    (item) => item.tool !== call.tool || conditionKey(item.when) !== key,
  );
  return [
    ...kept,
    {
      tool: call.tool,
      result: jsonOrText(answer.trim()),
      ...(when ? { when } : {}),
      ...(why?.trim() ? { why: why.trim() } : {}),
    },
  ];
}

/**
 * Steps 0..`through` as earlier messages: the assistant's text, and each call
 * with its answer. A call whose answer is after `through` is left out: the
 * copy's run decides it again.
 */
export function earlierFromSteps(
  steps: readonly ReplayTranscriptStep[],
  through: number,
): EvalMessage[] {
  return steps.slice(0, through + 1).flatMap((step, index): EvalMessage[] => {
    if (step.role === "assistant")
      return step.text.trim() ? [{ role: "assistant", text: step.text }] : [];
    const call = stepCall(steps, index)!;
    return [{ role: "tool", tool: call.tool, args: call.args, text: call.content }];
  });
}

/** RC-654: an agent reply a person wrote at a step: its text and the calls it makes. */
export interface AgentReplyEdit {
  text: string;
  calls: { name: string; args: Record<string, unknown> }[];
}

export const MAX_REPLY_TEXT = 20_000;
export const MAX_REPLY_CALLS = 20;

/**
 * RC-654: the steps a run starts with after a person edits the agent reply at
 * `step`: the run's steps before it, then the edited reply. The new run answers
 * the reply's calls and the agent goes on from there.
 */
export function openingWithReply(
  steps: readonly ReplayTranscriptStep[],
  step: number,
  reply: AgentReplyEdit,
): { ok: true; value: ReplayTranscriptStep[] } | { ok: false; error: string } {
  if (!Number.isInteger(step) || steps[step]?.role !== "assistant")
    return { ok: false, error: `Step ${step} is not an agent reply.` };
  return {
    ok: true,
    value: [...steps.slice(0, step), { role: "assistant", text: reply.text, calls: reply.calls }],
  };
}

/** RC-654: an edited reply from a form or a tool call: text, or at least one call with a tool name and object arguments. */
export function parseReply(
  input: unknown,
): { ok: true; value: AgentReplyEdit } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ok: false, error: "A reply has text and calls." };
  const { text = "", calls = [] } = input as { text?: unknown; calls?: unknown };
  if (typeof text !== "string" || text.length > MAX_REPLY_TEXT)
    return { ok: false, error: `The reply text must be at most ${MAX_REPLY_TEXT} characters.` };
  if (!Array.isArray(calls) || calls.length > MAX_REPLY_CALLS)
    return { ok: false, error: `A reply makes at most ${MAX_REPLY_CALLS} calls.` };
  const parsed: AgentReplyEdit["calls"] = [];
  for (const call of calls as unknown[]) {
    const { name, args } = (call ?? {}) as { name?: unknown; args?: unknown };
    if (typeof name !== "string" || !name.trim())
      return { ok: false, error: "Each call needs a tool name." };
    if (!args || typeof args !== "object" || Array.isArray(args))
      return { ok: false, error: `The arguments of ${name.trim()} must be a JSON object.` };
    parsed.push({ name: name.trim(), args: args as Record<string, unknown> });
  }
  if (!text.trim() && parsed.length === 0)
    return { ok: false, error: "Write the reply, or add a call." };
  return { ok: true, value: { text: text.trim(), calls: parsed } };
}

/** The transcript as steps, each tool step with its call's arguments and where its answer came from. */
export function replaySteps(
  transcript: EvalTranscript,
  toolAnswers: readonly EvalToolAnswer[],
): ReplayStepView[] {
  let answered = 0;
  return transcript.steps.map((step, index): ReplayStepView => {
    if (step.role === "assistant")
      return { index, role: "assistant", text: step.text, calls: step.calls };
    const answer = toolAnswers[answered];
    answered += 1;
    const matched = answer && answer.tool === step.tool ? answer : null;
    return {
      index,
      role: "tool",
      tool: step.tool,
      args: stepCall(transcript.steps, index)!.args,
      content: step.content,
      isError: step.isError,
      source: matched?.source ?? null,
      reason: matched?.reason ?? null,
      ...(matched?.why ? { why: matched.why } : {}),
    };
  });
}

/**
 * Where "Runs differ from here" goes between two replays: the first step that
 * is not the same (an assistant step by its text and calls, a tool step by its
 * tool and answer). Null when they are the same step for step.
 */
export function differStep(
  before: readonly ReplayStepView[],
  after: readonly ReplayStepView[],
): number | null {
  const key = (step: ReplayStepView | undefined) =>
    step === undefined
      ? null
      : step.role === "assistant"
        ? JSON.stringify(["assistant", step.text.trim(), step.calls.map((call) => call.name)])
        : JSON.stringify(["tool", step.tool, step.content]);
  for (let at = 0; at < Math.max(before.length, after.length); at += 1) {
    if (key(before[at]) !== key(after[at])) return at;
  }
  return null;
}

function conditionKey(when: Record<string, unknown> | undefined): string {
  return JSON.stringify(Object.entries(when ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

function jsonOrText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
