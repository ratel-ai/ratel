import { retryReaching, searchedAgainForSame } from "@/lib/ledger/same-ask";
import type { StepDraft, TurnSource } from "@/lib/ledger/types";
import { detectInTurn } from "@/lib/readings/trace-signals/self-corrections/detect";
import { DEFAULT_FLOORS } from "@/lib/readings/trace-signals/signals/catalog";
import {
  isInvoke,
  isListingSearch,
  listedType,
} from "@/lib/readings/trace-signals/signals/turn-facts";
import type {
  EvidenceTurn,
  SignalKind,
  StoryFlag,
  StoryQuery,
  TurnStoryStep,
} from "@/lib/readings/trace-signals/view";
import { duration } from "@/lib/views/health/signals/claims-model";

/**
 * One sampled turn told as a story (`searched "..."`, `listed 10`, `picked #7
 * assign_task`, `error`), with the step the signal is about flagged. Pure: the
 * caller (`evidence.ts`) reads the turn, its steps and the live `trace_events`
 * rows; query text exists only in those live rows and a pruned row reads
 * `expired`, never blank.
 */

/** A live `trace_events` row, as much of it as a story shows. */
export interface LiveEvent {
  query: string | null;
  traceId: string | null;
  /** OTLP-derived tool calls: whether the captured result was empty; null when not captured. */
  resultEmpty?: boolean | null;
}

export interface StoryInput {
  kind: SignalKind;
  subjectIds: readonly string[];
  names: ReadonlyMap<string, string>;
  turn: { id: string; startedAt: Date; turnSource: TurnSource };
  steps: readonly StepDraft[];
  /** Live rows by `trace_events.id`; a missing id was pruned. */
  events: ReadonlyMap<string, LiveEvent>;
}

/** Steps a story shows at most, centered on the first flagged one. */
export const STORY_MAX_STEPS = 12;

type Flags = Map<number, string>;

export function storyOf(input: StoryInput): EvidenceTurn {
  const flags = flagsFor(input);
  const firstFlagged = input.steps.findIndex((_, i) => flags.has(i));
  const start = Math.max(
    0,
    Math.min(firstFlagged < 0 ? 0 : firstFlagged - 3, input.steps.length - STORY_MAX_STEPS),
  );
  const shown = input.steps.slice(start, start + STORY_MAX_STEPS);
  const traceId =
    input.steps
      .map((s) => input.events.get(s.traceEventId)?.traceId ?? null)
      .find((id) => id !== null) ?? null;
  return {
    turnId: input.turn.id,
    traceId,
    startedAt: input.turn.startedAt.toISOString(),
    turnSource: input.turn.turnSource,
    steps: shown.map((step, i) => toStoryStep(step, input.events, flags.get(start + i))),
  };
}

function queryOf(step: StepDraft, events: ReadonlyMap<string, LiveEvent>): StoryQuery {
  const live = events.get(step.traceEventId);
  if (!live) return { state: "expired" };
  const text = live.query?.trim();
  return text ? { state: "captured", text } : { state: "not_captured" };
}

function toStoryStep(
  step: StepDraft,
  events: ReadonlyMap<string, LiveEvent>,
  label: string | undefined,
): TurnStoryStep {
  const flag: { flag?: StoryFlag } = label ? { flag: { label } } : {};
  if (step.kind === "search") {
    return {
      kind: "search",
      query: queryOf(step, events),
      listed: step.hitCount ?? step.hitIds?.length ?? 0,
      ...flag,
      eventId: step.traceEventId,
    };
  }
  return {
    kind: "invoke",
    toolId: step.targetId ?? "unknown",
    pickedRank: step.offeredRank,
    outcome: step.outcome ?? "unknown",
    tookMs: step.tookMs,
    ...flag,
    eventId: step.traceEventId,
  };
}

const callsOf = (steps: readonly StepDraft[], id: string | undefined): number[] =>
  steps.flatMap((s, i) => (isInvoke(s) && s.targetId === id ? [i] : []));

function flagsFor({ kind, subjectIds, names, steps, events }: StoryInput): Flags {
  const [a, b] = subjectIds;
  const name = (id: string | undefined) => (id ? (names.get(id) ?? id) : "");
  const flags: Flags = new Map();
  const listing = (i: number) => {
    const step = steps[i];
    return step !== undefined && isListingSearch(step) && listedType(step) === "tool";
  };
  switch (kind) {
    case "first_try_miss": {
      // The search the agent had to repeat: same ask, and it did not list the tool.
      const call = callsOf(steps, a)[0];
      const retry = call === undefined ? null : retryReaching(steps, steps[call]!);
      const missed = retry ? steps.indexOf(retry.previous) : -1;
      if (missed >= 0) flags.set(missed, `${name(a)} not listed`);
      break;
    }
    case "buried_tool": {
      const call = callsOf(steps, a)[0];
      if (call !== undefined) flags.set(call, `Picked from #${steps[call]!.offeredRank ?? "?"}`);
      break;
    }
    case "magnet": {
      const ran = callsOf(steps, a).length > 0;
      const shown = steps.findIndex((s, i) => listing(i) && (s.hitIds ?? []).includes(a ?? ""));
      // The agent was right not to pick it: the entry is clutter, not a miss.
      if (shown >= 0 && !ran)
        flags.set(
          shown,
          `${name(a)} at #${(steps[shown]!.hitIds ?? []).indexOf(a!) + 1} · not needed here`,
        );
      break;
    }
    case "sequence_chain": {
      const fromA = callsOf(steps, a)[0];
      const toB = callsOf(steps, b).find((i) => fromA !== undefined && i > fromA);
      if (fromA === undefined || toB === undefined) break;
      const between = steps.findIndex((s, i) => i > fromA && i < toB && s.kind === "search");
      if (between >= 0) flags.set(between, "A second search to reach the next tool");
      else flags.set(toB, "Ran next");
      break;
    }
    case "sibling_confusion": {
      const first = [...callsOf(steps, a), ...callsOf(steps, b)].sort((x, y) => x - y)[0];
      if (first !== undefined) flags.set(first, "Tried one of the two first");
      break;
    }
    case "error_loop": {
      const calls = callsOf(steps, a);
      const firstError = calls.find((i) => steps[i]!.outcome === "error");
      if (firstError === undefined) break;
      flags.set(firstError, "Fails");
      for (const i of calls) if (i > firstError) flags.set(i, "Retried");
      break;
    }
    case "no_follow_through": {
      const within = DEFAULT_FLOORS.no_follow_through.withinMs;
      const call = callsOf(steps, a).find((i) => searchedAgainForSame(steps, i, within));
      if (call !== undefined) flags.set(call, "Ran, then searched again for the same thing");
      break;
    }
    case "repeat_invoke": {
      const calls = callsOf(steps, a);
      calls.slice(1).forEach((i, n) => flags.set(i, n === 0 ? "Called again" : "And again"));
      break;
    }
    case "latency_outlier": {
      const slowest = callsOf(steps, a).sort(
        (x, y) => (steps[y]!.tookMs ?? 0) - (steps[x]!.tookMs ?? 0),
      )[0];
      if (slowest !== undefined)
        flags.set(slowest, `Took ${duration(steps[slowest]!.tookMs ?? 0)}`);
      break;
    }
    case "abandoned_search": {
      const last = steps.map((s) => s.kind).lastIndexOf("search");
      if (last >= 0) flags.set(last, "Ran nothing after this");
      break;
    }
    case "padding_share": {
      const first = steps.findIndex((_, i) => listing(i));
      if (first < 0) break;
      const search = steps[first]!;
      const picked = steps
        .filter((s) => isInvoke(s) && s.offeredByOrdinal === search.ordinal)
        .map((s) => s.offeredRank ?? Infinity);
      const listed = search.hitCount ?? search.hitIds?.length ?? 0;
      const best = Math.min(...picked);
      flags.set(
        first,
        Number.isFinite(best)
          ? `${listed} listed, picked #${best}`
          : `${listed} listed, none picked`,
      );
      break;
    }
    case "unstable_intent": {
      const first = steps.findIndex((s) => isInvoke(s));
      if (first >= 0) flags.set(first, "Started here");
      break;
    }
    case "tool_switch":
    case "empty_result":
    case "unknown_tool":
    case "long_turn":
      return otelFlags(kind, subjectIds, name, steps, events);
    case "blocked_action":
    case "identical_retry":
    case "wait_heavy":
      return frictionFlags(kind, subjectIds[0], steps);
    case "workflow_failing":
    case "workflow_slow":
    case "workflow_fixed_chain":
      return workflowFlags(kind, subjectIds, steps);
    case "dead_tool":
    case "fragmented_intents":
    case "cooccurring_intents":
    case "unused_tool":
    case "token_heavy":
      break;
    case "system_turn_failing":
    case "agent_failing": {
      const failed = steps.findIndex((s) => isInvoke(s) && s.outcome === "error");
      if (failed >= 0) flags.set(failed, "Failed");
      break;
    }
    case "self_correcting":
      return selfCorrectionFlags(subjectIds, steps);
  }
  return flags;
}

/** What a failed call led to, worst first: the turn ended there, it was retried, or the agent moved on. */
const AFTER_FAILURE = [
  ["gave_up_after_error", "Failed, and the agent gave up"],
  ["retry_after_error", "Failed, then the agent retried it"],
  ["switch_after_error", "Failed, then the agent switched tools"],
] as const;

/**
 * Flags for `self_correcting`: every self-correction in the turn after one of
 * the subject's tools (the one tool of a per-tool issue, a task's tools for a
 * per-task one), on the call it came after; a repeated search on itself.
 * Asking again and reply phrases live outside the steps and are not flagged.
 */
function selfCorrectionFlags(subjectIds: readonly string[], steps: readonly StepDraft[]): Flags {
  const flags: Flags = new Map();
  const subject = new Set(subjectIds);
  const events = detectInTurn(steps).filter(
    (event) => event.tool === null || subject.has(event.tool.replace(/^skill:/, "")),
  );
  const indexOf = (ordinal: number | null) => steps.findIndex((step) => step.ordinal === ordinal);
  for (const [kind, label] of AFTER_FAILURE) {
    for (const event of events.filter((e) => e.kind === kind)) {
      const at = indexOf(event.toolOrdinal);
      if (at >= 0 && !flags.has(at)) flags.set(at, label);
    }
  }
  for (const event of events.filter((e) => e.kind === "searched_again")) {
    const at = indexOf(event.ordinal);
    if (at >= 0 && !flags.has(at)) flags.set(at, "Searched again for the same thing");
  }
  return flags;
}

/** Flags for the kinds about refused calls, unchanged retries and waits: the subject tool's calls. */
function frictionFlags(
  kind: "blocked_action" | "identical_retry" | "wait_heavy",
  tool: string | undefined,
  steps: readonly StepDraft[],
): Flags {
  const flags: Flags = new Map();
  const calls = callsOf(steps, tool);
  switch (kind) {
    case "blocked_action":
      for (const i of calls.filter((i) => steps[i]!.outcome === "error")) flags.set(i, "Refused");
      break;
    case "identical_retry": {
      const failed = calls.findIndex((i) => steps[i]!.outcome === "error");
      if (failed < 0) break;
      flags.set(calls[failed]!, "Failed");
      if (calls[failed + 1] !== undefined) flags.set(calls[failed + 1]!, "Sent again");
      break;
    }
    case "wait_heavy":
      for (const i of calls) {
        const ms = steps[i]!.tookMs;
        if (ms !== null) flags.set(i, `Waited ${duration(ms)}`);
      }
      break;
  }
  return flags;
}

/** Flags for the kinds read from OpenTelemetry, which mark tool calls only. */
function otelFlags(
  kind: "tool_switch" | "empty_result" | "unknown_tool" | "long_turn",
  subjectIds: readonly string[],
  name: (id: string | undefined) => string,
  steps: readonly StepDraft[],
  events: ReadonlyMap<string, LiveEvent>,
): Flags {
  const [a, b] = subjectIds;
  const flags: Flags = new Map();
  const empty = (i: number) => events.get(steps[i]!.traceEventId)?.resultEmpty === true;
  switch (kind) {
    case "tool_switch": {
      const invokes = steps.flatMap((s, i) => (isInvoke(s) ? [i] : []));
      const letDown = (i: number) => steps[i]!.outcome === "error" || empty(i);
      const at = invokes.findIndex((i, n) => {
        const next = invokes[n + 1];
        return (
          next !== undefined &&
          steps[i]!.targetId === a &&
          steps[next]!.targetId === b &&
          letDown(i)
        );
      });
      if (at < 0) break;
      flags.set(
        invokes[at]!,
        steps[invokes[at]!]!.outcome === "error" ? "Failed" : "Came back empty",
      );
      flags.set(invokes[at + 1]!, `Switched to ${name(b)}`);
      break;
    }
    case "empty_result":
      for (const i of callsOf(steps, a).filter(empty)) flags.set(i, "Came back empty");
      break;
    case "unknown_tool":
      callsOf(steps, a).forEach((i, n) =>
        flags.set(i, n === 0 ? "Not a tool the agent has" : "Called again"),
      );
      break;
    case "long_turn": {
      const lean = subjectIds.map((id) => callsOf(steps, id)[0]).find((i) => i !== undefined);
      if (lean !== undefined)
        flags.set(lean, `${name(steps[lean]!.targetId ?? undefined)} shows up often in long turns`);
      break;
    }
  }
  return flags;
}

/** Flags for the workflow kinds: the step the run stopped at, its slowest step, or where the chain starts. */
function workflowFlags(
  kind: "workflow_failing" | "workflow_slow" | "workflow_fixed_chain",
  subjectIds: readonly string[],
  steps: readonly StepDraft[],
): Flags {
  const flags: Flags = new Map();
  const tools = steps.flatMap((s, i) => (isInvoke(s) && s.targetType === "tool" ? [i] : []));
  switch (kind) {
    case "workflow_failing": {
      const last = tools[tools.length - 1];
      if (last !== undefined && steps[last]!.outcome === "error")
        flags.set(last, "Failed here, and the run stopped");
      break;
    }
    case "workflow_slow": {
      const took = (i: number) => steps[i]!.tookMs ?? -1;
      const slowest = tools.reduce<number | undefined>(
        (best, i) => (took(i) > (best === undefined ? -1 : took(best)) ? i : best),
        undefined,
      );
      if (slowest !== undefined) flags.set(slowest, `Slowest step, ${duration(took(slowest))}`);
      break;
    }
    case "workflow_fixed_chain": {
      const first = tools.find((i) => steps[i]!.targetId === subjectIds[0]);
      if (first !== undefined) flags.set(first, "The usual sequence starts here");
      break;
    }
  }
  return flags;
}
