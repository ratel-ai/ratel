import type { ToolAnswerReason, ToolAnswerSource } from "@/lib/views/eval-gate/types";
import { SCORER_LABELS } from "@/lib/views/task-scorers/labels";
import type { Scorer, ScorerKind } from "@/lib/views/task-scorers/types";
import { type EvalScoring, effectiveScorers } from "./domain/scoring";
import {
  EVAL_SPEC_FIELDS,
  type EvalResult,
  type EvalSpecField,
  type EvalToolAnswer,
  type EvalVerdict,
} from "./domain/types";

/**
 * RC-292: the single test view as data (F1, F3, G1–G3, G5): what should
 * happen in words, where each tool answer came from and why, and the replay's
 * steps. Pure.
 */

export const SOURCE_ORDER: readonly ToolAnswerSource[] = [
  "mock",
  "composed",
  "recorded",
  "earlier",
  "stand-in",
];

/** RC-657: the term list of the UX audit (RC-656): "fixed answer" and "simulated answer", never "mock" or "stand-in". */
export const SOURCE_LABELS: Record<ToolAnswerSource, string> = {
  composed: "Merged",
  recorded: "Recorded",
  earlier: "From earlier",
  "stand-in": "Simulated answer",
  mock: "Fixed answer",
};

/** The count words of each source: "2 fixed answers", "1 recorded". */
const SOURCE_COUNT_WORDS: Record<ToolAnswerSource, readonly [string, string]> = {
  composed: ["merged", "merged"],
  recorded: ["recorded", "recorded"],
  earlier: ["from earlier", "from earlier"],
  "stand-in": ["simulated answer", "simulated answers"],
  mock: ["fixed answer", "fixed answers"],
};

/** The general rule of each source (G2). */
export const SOURCE_RULES: Record<ToolAnswerSource, string> = {
  recorded: "A call that matches the recording gets the recorded answer.",
  composed:
    "A merged tool's call gets the recorded answers of the tools it replaces, put together.",
  earlier: "A call the conversation already made before this message gets the same answer again.",
  "stand-in":
    "No recorded answer matches this call, so a model simulated the answer from the tool's description and the conversation. Check it before you trust the result.",
  mock: "A fixed answer you set for this tool wins over the recording.",
};

/** Why this call got that source (G3). */
export const REASON_TEXT: Record<ToolAnswerReason, string> = {
  matched_recording: "The recording made this call with the same arguments.",
  merged_from_sources:
    "This tool replaces tools the recording called, and the call asks for what they did.",
  answered_before_run: "An earlier turn of the conversation made this call.",
  stand_in_model: "The recording has no call with these arguments.",
  no_stand_in:
    "The recording has no call with these arguments and no tool answer model was set up, so the call failed.",
  fixed_answer: "This eval fixes the answer of this tool for calls like this one.",
};

export type TestStep =
  | {
      kind: "tool";
      tool: string;
      source: ToolAnswerSource;
      rule: string;
      reason: string;
      ms: number | null;
      args: string | null;
      result: string | null;
      isError: boolean;
    }
  | { kind: "reply"; text: string };

/** RC-309: one turn of a multi-turn result. `status` "none": nothing was scored on it. */
export interface TurnRow {
  label: string;
  kind: "Fixed message" | "Simulated person";
  status: "pass" | "fail" | "none";
  /** The person's words; null without the content opt-in. */
  message: string | null;
  verdicts: { kind: ScorerKind; label: string; status: EvalVerdict["status"]; measured: string }[];
}

export interface RuleWithSource {
  scorer: Scorer;
  sentence: string;
  /** `eval`: this eval sets or overrides it; `task`: its tasks do. */
  setBy: "eval" | "task";
}

/** One scorer as the sentence "What should happen" shows. */
export function scorerSentence(scorer: Scorer): string {
  switch (scorer.kind) {
    case "ends_well":
      return "The last tool call succeeds and the agent replies";
    case "max_self_corrections":
      return scorer.max === 0
        ? "No self-corrections"
        : `At most ${scorer.max} self-${scorer.max === 1 ? "correction" : "corrections"}`;
    case "max_cost_usd":
      return `Costs at most ${formatUsd(scorer.max)}`;
    case "max_latency_ms":
      return `Takes at most ${formatSeconds(scorer.max)}`;
    case "max_tool_calls":
      return `At most ${scorer.max} tool ${scorer.max === 1 ? "call" : "calls"}`;
    case "expected_tool":
      return `Calls ${scorer.tool}`;
    case "judge_criteria":
      return scorer.criteria;
  }
}

/** What a verdict measured, in its scorer's unit. */
export function measuredText(verdict: EvalVerdict): string {
  if (verdict.status === "skip") return "not measured";
  if (typeof verdict.measured === "string") return verdict.measured;
  if (verdict.measured === null) return "";
  if (verdict.kind === "max_cost_usd") return formatUsd(verdict.measured);
  if (verdict.kind === "max_latency_ms") return formatSeconds(verdict.measured);
  return String(verdict.measured);
}

/** The eval's scorers, each with whether the eval or its tasks set it (the Definition tab's "Set by"). */
export function rulesWithSource(
  scorers: readonly Scorer[],
  scoring: EvalScoring,
): RuleWithSource[] {
  return scorers.map((scorer) => {
    const check = scoring.checks[scorer.kind];
    const own =
      (check?.on && typeof check.max === "number") ||
      (scorer.kind === "expected_tool" && !!scoring.expectedTool) ||
      (scorer.kind === "judge_criteria" && !!scoring.criteria.trim()) ||
      (scorer.kind === "ends_well" && check?.on === true);
    return { scorer, sentence: scorerSentence(scorer), setBy: own ? "eval" : "task" };
  });
}

/** The eval's scorers from its tasks' scorers and its own checks. */
export function evalRules(
  taskScorers: readonly (readonly Scorer[])[],
  scoring: EvalScoring,
): RuleWithSource[] {
  return rulesWithSource(effectiveScorers(taskScorers, scoring), scoring);
}

/** "1 merged · 2 recorded": one entry per source used, in `SOURCE_ORDER`. */
export function sourceCounts(
  answers: readonly EvalToolAnswer[],
): { source: ToolAnswerSource; count: number; label: string }[] {
  return SOURCE_ORDER.flatMap((source) => {
    const count = answers.filter((answer) => answer.source === source).length;
    return count > 0
      ? [{ source, count, label: `${count} ${SOURCE_COUNT_WORDS[source][count === 1 ? 0 : 1]}` }]
      : [];
  });
}

/**
 * The replay's steps: each tool call with its source, rule, reason and time,
 * and the reply. Args, results and the reply come from the transcript, kept
 * only with the project's content opt-in on; without it the calls remain.
 */
export function testSteps(result: Pick<EvalResult, "toolAnswers" | "transcript">): {
  steps: TestStep[];
  textKept: boolean;
} {
  const toolStep = (
    answer: EvalToolAnswer,
    text: { args: unknown; result: string; isError: boolean } | null,
  ): TestStep => ({
    kind: "tool",
    tool: answer.tool,
    source: answer.source,
    rule: SOURCE_RULES[answer.source],
    reason: [REASON_TEXT[answer.reason] ?? "", answer.why ? `Why: ${answer.why}` : ""]
      .filter(Boolean)
      .join(" "),
    ms: answer.ms,
    args: text ? pretty(text.args) : null,
    result: text ? prettyText(text.result) : null,
    isError: text?.isError ?? false,
  });
  if (!result.transcript)
    return { steps: result.toolAnswers.map((answer) => toolStep(answer, null)), textKept: false };
  const steps: TestStep[] = [];
  const pendingArgs: unknown[] = [];
  let next = 0;
  for (const step of result.transcript.steps) {
    if (step.role === "assistant") {
      pendingArgs.push(...step.calls.map((call) => call.args));
      if (step.calls.length === 0 && step.text.trim())
        steps.push({ kind: "reply", text: step.text });
      continue;
    }
    const answer = result.toolAnswers[next] ?? {
      tool: step.tool,
      source: "recorded" as const,
      reason: "matched_recording" as const,
      ms: null,
    };
    next += 1;
    steps.push(
      toolStep(answer, {
        args: pendingArgs.shift() ?? {},
        result: step.content,
        isError: step.isError,
      }),
    );
  }
  return { steps, textKept: true };
}

/**
 * F2: where "Runs differ from here" goes, the first step that is not the same
 * on both sides (a tool by name, a reply by its text). Null when the two runs
 * are the same step for step.
 */
export function differIndex(
  before: readonly TestStep[],
  after: readonly TestStep[],
): number | null {
  const key = (step: TestStep | undefined) =>
    step === undefined ? null : step.kind === "tool" ? `tool:${step.tool}` : `reply:${step.text}`;
  for (let at = 0; at < Math.max(before.length, after.length); at += 1) {
    if (key(before[at]) !== key(after[at])) return at;
  }
  return null;
}

/**
 * RC-309: "Passed 2 of 3 runs" for a result that ran several times (a
 * simulated person, Q4); null for one that ran once or an older row.
 */
export function attemptsLine(
  result: Pick<EvalResult, "attempts" | "passed" | "error">,
): string | null {
  const attempts = result.attempts;
  if (!attempts) return null;
  const runs = `${attempts.total} ${attempts.total === 1 ? "run" : "runs"}`;
  if (result.error) return `Passed ${attempts.passed} of ${runs} before it stopped`;
  if (result.passed === null) return `Not scored in ${runs}`;
  return `Passed ${attempts.passed} of ${runs}`;
}

/** RC-609: the name of each spec input, as the eval page shows it. */
export const SPEC_FIELD_LABELS: Record<EvalSpecField, string> = {
  systemPrompt: "System prompt",
  message: "Message",
  tools: "Tool list",
  context: "Context values",
};

/** RC-609: "A model wrote the system prompt and tool list of this run." Null when the run used no model-written input. */
export function generatedLine(result: Pick<EvalResult, "generated">): string | null {
  const used = EVAL_SPEC_FIELDS.filter((field) => result.generated?.includes(field));
  if (used.length === 0) return null;
  const names = used.map((field) => SPEC_FIELD_LABELS[field].toLowerCase());
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `A model wrote the ${list} of this run: the recording did not have ${used.length === 1 ? "it" : "them"}. A pass that rests on ${used.length === 1 ? "it" : "them"} is unverified.`;
}

/** RC-309: each turn with its kind, result and verdicts; null for a single-turn result. Turn 1 is the recorded ask. */
export function turnRows(result: Pick<EvalResult, "turns">): TurnRow[] | null {
  if (!result.turns || result.turns.length === 0) return null;
  return result.turns.map((turn, index) => ({
    label: `Turn ${index + 1}`,
    kind: turn.simulated ? "Simulated person" : "Fixed message",
    status: turn.passed === null ? "none" : turn.passed ? "pass" : "fail",
    message: turn.message,
    verdicts: turn.verdicts.map((verdict) => ({
      kind: verdict.kind,
      label: SCORER_LABELS[verdict.kind],
      status: verdict.status,
      measured: measuredText(verdict),
    })),
  }));
}

/** "14 s · $0.0194 · 3 tool calls". */
export function totalsLine(
  result: Pick<EvalResult, "durationMs" | "costUsd" | "toolCalls">,
): string {
  return [
    result.durationMs !== null ? formatSeconds(result.durationMs) : null,
    result.costUsd !== null ? formatUsd(result.costUsd) : null,
    result.toolCalls !== null
      ? `${result.toolCalls} tool ${result.toolCalls === 1 ? "call" : "calls"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "17 of 20" and the evals before and after, in the run table's order. Null when the eval is not in the run. */
export function neighbours(
  order: readonly string[],
  evalId: string,
): { index: number; total: number; prev: string | null; next: string | null } | null {
  const at = order.indexOf(evalId);
  if (at === -1) return null;
  return {
    index: at + 1,
    total: order.length,
    prev: order[at - 1] ?? null,
    next: order[at + 1] ?? null,
  };
}

/** Limits sit close to what runs cost, so four places under a dollar ("$0.0177"). */
function formatUsd(value: number): string {
  return `$${value < 1 ? value.toFixed(4) : value.toFixed(2)}`;
}

/** "12.7 s", "14 s". */
function formatSeconds(ms: number): string {
  const seconds = Math.round(ms / 100) / 10;
  return `${Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1)} s`;
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function prettyText(content: string): string {
  try {
    return pretty(JSON.parse(content));
  } catch {
    return content;
  }
}
