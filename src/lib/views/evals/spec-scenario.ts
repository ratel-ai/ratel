import type { ReplayMessage } from "@/lib/views/eval-gate/models";
import {
  answeredCalls,
  type Recording,
  recordedScenario,
  type ScenarioBuilder,
} from "@/lib/views/eval-gate/scenario";
import type { RunRecord } from "@/lib/views/eval-gate/types";
import type { Eval, EvalSpecField } from "./domain/types";
import type { EvalReplay } from "./job";

/**
 * RC-609: the scenario of an eval that has a spec (RC-608). The recording's
 * values win; what it lacks comes from the eval: the system prompt, the
 * tools, and with no recording at all the eval's own message. The eval's
 * context goes to the model (in the system prompt) and to the tool stand-in,
 * so the IDs a first call passes are grounded: the replay never refuses for
 * missing prompts or unseen IDs. `filled` names the inputs taken from the eval.
 * RC-642: a field a person edited (`edited`) wins over the recording, so an edit of the system prompt, the tools or the message
 * changes the replay of a recorded run too.
 */

export type EvalSpec = Pick<
  Eval,
  "message" | "systemPrompt" | "tools" | "context" | "generated" | "edited"
>;

/** The scenario builder for `spec`; null for an eval without a spec (made with the gate off), which replays as recorded. */
export function specScenarioOf(spec: EvalSpec): ScenarioBuilder | null {
  if (!hasSpec(spec)) return null;
  return (request) => {
    const context = spec.context && Object.keys(spec.context).length > 0 ? spec.context : null;
    const recorded = recordedScenario(request);
    const filled: string[] = [];
    const handSet = new Set<string>(spec.edited ?? []);
    const take = <T>(
      own: T | null | undefined,
      fromSpec: T | null | undefined,
      field: string,
      usable: (value: T) => boolean,
    ): T | null => {
      const person =
        handSet.has(field) && fromSpec !== null && fromSpec !== undefined && usable(fromSpec);
      if (!person && own !== null && own !== undefined && usable(own)) return own;
      if (fromSpec === null || fromSpec === undefined || !usable(fromSpec)) return own ?? null;
      filled.push(field);
      return fromSpec;
    };
    const system = take(
      recorded?.system,
      spec.systemPrompt,
      "systemPrompt",
      (value) => value.trim().length > 0,
    );
    const tools = take(recorded?.tools, spec.tools, "tools", (value) => value.length > 0) ?? [];
    const base: Recording = recorded
      ? withAsk(
          recorded,
          handSet.has("message") ? spec.message : null,
          request.history?.length ?? 0,
          request.after?.length ?? 0,
        )
      : fromSpecOnly(spec.message, request.history ?? [], request.after ?? []);
    if (!recorded || base !== recorded) filled.push("message");
    if (context) filled.push("context");
    return {
      ...base,
      system: withContext(system ?? undefined, context),
      tools: tools.map((tool) => ({ ...tool })),
      filled,
      ...(context ? { context } : {}),
    };
  };
}

/** The inputs a replay of this eval takes from its spec, of those the model wrote (RC-608 `generated`). */
export function generatedInputsOf(spec: EvalSpec, replay: EvalReplay): EvalSpecField[] {
  const filled = specScenarioOf(spec)?.({ run: replay.run, calls: replay.calls })?.filled ?? [];
  return (spec.generated ?? []).filter((field) => filled.includes(field));
}

/** RC-609: a stand-in for the run an eval with a spec has no recording of (no source run, or it expired). */
export function specOnlyReplay(evalId: string, createdAt: Date): EvalReplay {
  const run: RunRecord = {
    turnId: evalId,
    traceId: null,
    startedAt: createdAt.toISOString(),
    taskId: null,
    steps: [],
  };
  return { run, calls: [] };
}

/** Whether the eval was made with a spec (RC-608, the gate on). */
export function hasSpec(spec: EvalSpec): boolean {
  return spec.generated !== undefined || (spec.edited?.length ?? 0) > 0;
}

/**
 * RC-642: the recording with its ask replaced by `ask`. The ask is the last
 * person message of the recording's own history: after the eval's `before`
 * earlier messages and before its `after` turns. The same recording when there
 * is none to replace.
 */
function withAsk(
  recording: Recording,
  ask: string | null,
  before: number,
  after: number,
): Recording {
  if (!ask?.trim()) return recording;
  const own = recording.history.slice(before, recording.history.length - after);
  const at = own.findLastIndex((message) => message.role === "user");
  if (at === -1 || (own[at] as { text: string }).text === ask) return recording;
  return {
    ...recording,
    history: recording.history.map((message, index) =>
      index === before + at ? { role: "user", text: ask } : message,
    ),
  };
}

/** A scenario from the eval alone: its earlier messages, its message, then what comes after. */
function fromSpecOnly(
  message: string,
  history: readonly ReplayMessage[],
  after: readonly ReplayMessage[],
): Recording {
  const messages: ReplayMessage[] = [...history, { role: "user", text: message }, ...after];
  return {
    history: messages,
    system: undefined,
    tools: [],
    calls: [],
    earlier: answeredCalls(messages),
    model: null,
    toolMs: 0,
    inputTokens: 0,
  };
}

function withContext(
  system: string | undefined,
  context: Readonly<Record<string, string>> | null,
): string | undefined {
  if (!context) return system;
  const known = `Known values for this request: ${Object.entries(context)
    .map(([name, value]) => `${name}: ${value}`)
    .join("; ")}.`;
  return system ? `${system}\n\n${known}` : known;
}
