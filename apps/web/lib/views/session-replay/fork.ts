import { costFor, priceFor } from "@/lib/ingest/pricing";
import { getLogger } from "@/lib/platform/logger";
import type { ModelCall } from "@/lib/views/eval-gate/calls";
import { emptyChange } from "@/lib/views/eval-gate/change";
import { CANT_SIMULATE } from "@/lib/views/eval-gate/method";
import {
  AGENT_MAX_TOKENS,
  type EvalModels,
  estimateTokens,
  ModelRefused,
  recordBudgetRefusal,
  type SpendMeter,
} from "@/lib/views/eval-gate/models";
import {
  type Recording,
  type ReplayInput,
  readRecording,
  replayInput,
  toReplayMessages,
} from "@/lib/views/eval-gate/replay";
import type { Ranker } from "@/lib/views/eval-gate/simulate";
import type {
  CraftedToolDef,
  FixChange,
  InvokeStep,
  RunRecord,
  SearchStep,
  ToolDef,
} from "@/lib/views/eval-gate/types";
import { rerankChange, type Variant } from "./variant";

/**
 * The What-if engine (RC-175): fork one model call of a session with one
 * change, and ask the model for its next action k times on each side.
 *
 * It sits on top of the eval gate's replay (`replayInput`), which it calls
 * unchanged: the recording here starts at model call N (not the first one),
 * and the variant can also add or take away a tool. Each sample is one model
 * call, no tool runs: the result is the tool each side picks, how often, and
 * what it cost. Without captured content the step's recorded search is
 * re-ranked instead, and the result says so.
 *
 * Nothing textual comes back: tool names, counts and numbers only.
 */

export type WhatIfMethod = "replay" | "rerank";

/** The distribution key of a sample that answered without a tool. */
export const NO_TOOL = "(answer)";
export const DEFAULT_K = 5;
export const MAX_K = 10;

const RERANK_NOTE =
  "No captured content for this step: re-ranked its recorded search without the model.";
const NOT_AFFECTED = "Nothing the change touches in what this step's model saw";
/** How deep a re-rank reads its lists: only the top hit counts as the choice. */
const RERANK_DEPTH = 5;

const logger = getLogger("session-replay/fork");

export interface StepRecording {
  /** The recording as model call N saw it: its history is that call's input. */
  recording: Recording;
  /** The tool call N chose; null when it answered. */
  recorded: string | null;
}

export interface SampleDeps {
  models: EvalModels;
  spend: SpendMeter;
  /** Samples per side, clamped to 1..`MAX_K`. */
  k: number;
  /** Tool definitions seen in the project, for a skill's steps the step was never offered. */
  toolDefs: ReadonlyMap<string, ToolDef>;
  /** A ranker over the project's catalog with a change applied; null when there is no catalog. */
  rank: ((change: FixChange) => Ranker | null) | null;
}

export interface SideSample {
  /** The tool picked most often (first seen wins a tie); null when answering won. */
  choice: string | null;
  /** Tool name (or `NO_TOOL`) → how many samples picked it. */
  distribution: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  /** What the samples cost at the recorded model's price; null when it has none. */
  costUsd: number | null;
}

export type StepSample =
  | {
      ok: true;
      method: WhatIfMethod;
      k: number;
      recorded: string | null;
      before: SideSample;
      after: SideSample;
      note: string | null;
    }
  | { ok: false; reason: string; notAffected?: boolean };

/** Fork model call `n` (0-based) of a run with `variant`, and sample both sides. */
export async function sampleStep(
  run: RunRecord,
  calls: readonly ModelCall[],
  n: number,
  variant: Variant,
  deps: SampleDeps,
): Promise<StepSample> {
  const step = recordingAt(calls, n, run);
  if (!step) return rerankStep(run, n, variant, deps);
  const control = replayInput(step.recording, null, deps.toolDefs);
  const forked = forkInput(step.recording, variant, deps.toolDefs);
  if (!forked.touched) return { ok: false, reason: NOT_AFFECTED, notAffected: true };
  if (!deps.models.agent) return { ok: false, reason: CANT_SIMULATE.noModel };
  logger.info(variantBuiltFields(variant, "replay"), "what_if_variant_built");
  const k = clampK(deps.k);
  try {
    const before = await sampleSide(step.recording, control, k, deps);
    const after = await sampleSide(step.recording, forked, k, deps);
    return { ok: true, method: "replay", k, recorded: step.recorded, before, after, note: null };
  } catch (err) {
    if (err instanceof BudgetSpent) return { ok: false, reason: CANT_SIMULATE.budget };
    if (err instanceof ModelRefused) {
      logger.error({ err, turn_id: run.turnId }, "what if model key refused");
      return { ok: false, reason: CANT_SIMULATE.refused };
    }
    logger.error({ err, turn_id: run.turnId }, "what if sample failed");
    return { ok: false, reason: CANT_SIMULATE.failed };
  }
}

/**
 * The recording as model call `n` (0-based) saw it: its input is the
 * history, the calls after it are what the run did next. Null when that call
 * wasn't captured or doesn't exist.
 */
export function recordingAt(
  calls: readonly ModelCall[],
  n: number,
  run?: RunRecord,
): StepRecording | null {
  const call = calls[n];
  const messages = call?.payload?.messages;
  if (!call || !messages || messages.length === 0) return null;
  const window = calls.slice(n);
  // A run whose steps start where call N does, so a recorded failure lines up with its call.
  const done = toReplayMessages(messages.slice(0, -1)).filter(
    (message) => message.role === "tool",
  ).length;
  const invokes = (run?.steps ?? [])
    .filter((item): item is InvokeStep => item.kind === "invoke")
    .slice(done);
  const stepRun: RunRecord = {
    turnId: run?.turnId ?? call.turnId,
    traceId: run?.traceId ?? null,
    startedAt: run?.startedAt ?? call.occurredAt.toISOString(),
    taskId: run?.taskId ?? null,
    steps: invokes,
  };
  // `readRecording` starts at the first captured call: call N must be one.
  if (!readRecording(stepRun, [call])) return null;
  const recording = readRecording(stepRun, window);
  if (!recording) return null;
  const output = toReplayMessages(messages.slice(-1))[0];
  const recorded =
    output?.role === "assistant"
      ? (output.calls[0]?.name ?? null)
      : (recording.calls[0]?.name ?? null);
  return { recording, recorded };
}

/**
 * The model's input at the step with the variant applied. `replayInput` is
 * called unchanged for what it serves (a fix, a tool craft, a tuned
 * definition); adding, removing and overriding a description are applied on
 * its control.
 */
export function forkInput(
  recording: Recording,
  variant: Variant,
  toolDefs: ReadonlyMap<string, ToolDef>,
): ReplayInput {
  switch (variant.kind) {
    case "fix":
      return replayInput(recording, variant.change, toolDefs);
    case "tool_craft":
      return replayInput(recording, replayChange(variant.tools), toolDefs);
    case "definition":
      return replayInput(recording, replayChange([{ ...variant.tool, replaces: [] }]), toolDefs);
    case "catalog_override": {
      const input = replayInput(recording, null, toolDefs);
      const tool = input.tools.find((item) => item.name === variant.tool);
      if (!tool) return input;
      tool.description = variant.searchable;
      return { ...input, touched: true };
    }
    case "add_tool": {
      const input = replayInput(recording, null, toolDefs);
      if (input.tools.some((item) => item.name === variant.tool.name)) return input;
      return { ...input, tools: [...input.tools, { ...variant.tool }], touched: true };
    }
    case "remove_tool": {
      const input = replayInput(recording, null, toolDefs);
      const tools = input.tools.filter((item) => item.name !== variant.tool);
      return tools.length === input.tools.length ? input : { ...input, tools, touched: true };
    }
  }
}

/** The fields of `what_if_variant_built`: the change's kind and the method, never its definitions. */
export function variantBuiltFields(
  variant: Variant,
  method: WhatIfMethod,
): Record<string, unknown> {
  return { change_kind: variant.kind, method };
}

/* - Sampling ---------------------------------------------------------------- */

class BudgetSpent extends Error {
  constructor() {
    super("what if budget spent");
    this.name = "BudgetSpent";
  }
}

function clampK(k: number): number {
  return Math.min(MAX_K, Math.max(1, Math.floor(Number.isFinite(k) ? k : DEFAULT_K)));
}

/** One side: k fresh agents, each asked once for its next action at the step. */
async function sampleSide(
  recording: Recording,
  input: ReplayInput,
  k: number,
  deps: SampleDeps,
): Promise<SideSample> {
  const picks: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = 0;
  const context = {
    recordedModel: recording.model,
    recorded: recording.calls.map(({ id, name, args }) => ({ id, name, args })),
  };
  for (let i = 0; i < k; i += 1) {
    const agent = deps.models.agent!(context);
    if (!agent) throw new Error("no agent for a what if sample");
    const priced = recording.model && priceFor(recording.model) ? recording.model : agent.model;
    const estimate = {
      inputTokens: Math.max(
        recording.inputTokens,
        estimateTokens(input.system, input.tools, recording.history),
      ),
      outputTokens: AGENT_MAX_TOKENS,
    };
    const hold = await deps.spend.reserve(agent.model, estimate);
    if (!hold) {
      recordBudgetRefusal(agent, "eval_gate_what_if");
      throw new BudgetSpent();
    }
    let reply: Awaited<ReturnType<typeof agent.next>>;
    try {
      reply = await agent.next({
        system: input.system,
        tools: input.tools,
        messages: recording.history,
      });
    } catch (err) {
      deps.spend.release(hold);
      throw err;
    }
    deps.spend.settle(hold, reply.model, reply.usage);
    picks.push(reply.calls[0]?.name ?? NO_TOOL);
    inputTokens += reply.usage.inputTokens;
    outputTokens += reply.usage.outputTokens;
    const cost = costFor(priced, {
      input_tokens: reply.usage.inputTokens,
      output_tokens: reply.usage.outputTokens,
      cached_tokens: reply.usage.cachedTokens,
    });
    costUsd = costUsd === null || cost === null ? null : costUsd + cost;
  }
  return { ...distributionOf(picks), inputTokens, outputTokens, costUsd };
}

/**
 * The step without captured content: its recorded search ranked again with
 * and without the change, the top hit as each side's choice. Deterministic,
 * so one sample per side, and no model is called.
 */
function rerankStep(run: RunRecord, n: number, variant: Variant, deps: SampleDeps): StepSample {
  const invokes = run.steps.filter((item): item is InvokeStep => item.kind === "invoke");
  const at = invokes[n]?.ordinal ?? Number.POSITIVE_INFINITY;
  const search = run.steps
    .filter(
      (item): item is SearchStep =>
        item.kind === "search" &&
        item.ordinal < at &&
        !!item.query &&
        (item.searchType ?? "tool_search") !== "skill_search",
    )
    .pop();
  const ranker = search && deps.rank ? deps.rank(rerankChange(variant)) : null;
  if (!search?.query || !ranker) return { ok: false, reason: CANT_SIMULATE.noPrompts };
  logger.info(variantBuiltFields(variant, "rerank"), "what_if_variant_built");
  const side = (hits: string[]): SideSample => ({
    ...distributionOf([hits[0] ?? NO_TOOL]),
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  });
  const depth = Math.max(RERANK_DEPTH, search.topK ?? 0);
  return {
    ok: true,
    method: "rerank",
    k: 1,
    recorded: invokes[n]?.targetId ?? null,
    before: side(ranker.before(search.query, depth)),
    after: side(ranker.after(search.query, depth)),
    note: RERANK_NOTE,
  };
}

function distributionOf(picks: readonly string[]): Pick<SideSample, "choice" | "distribution"> {
  const distribution: Record<string, number> = {};
  for (const pick of picks) distribution[pick] = (distribution[pick] ?? 0) + 1;
  let top: string | null = null;
  for (const [pick, count] of Object.entries(distribution))
    if (top === null || count > distribution[top]!) top = pick;
  return { choice: top === null || top === NO_TOOL ? null : top, distribution };
}

/** Crafted definitions as the replay part of a change, for `replayInput`. */
function replayChange(tools: CraftedToolDef[]): FixChange {
  return { ...emptyChange(), replay: { tools, failClearly: [], prerequisite: null, skill: null } };
}
