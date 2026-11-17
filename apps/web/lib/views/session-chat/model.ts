import type { LensPart } from "@/lib/views/session-replay/composition";
import type {
  SessionTimeline,
  StepMark,
  TimelineStep,
  TimelineTurn,
} from "@/lib/views/session-replay/timeline";

/**
 * The session replay as a chat (RC-281): per turn the person's ask, the work
 * line ("4 actions · 11 s · 2 to check") and the reply, plus the time-scaled
 * track under it. Pure: `load.ts` reads the rows and the text.
 *
 * The track is in "track ms": real time, except that each step is at least
 * {@link MIN_SEGMENT_MS} wide (an ask, or a step with no measured time) and a
 * pause longer than {@link WAIT_THRESHOLD_MS} collapses to a {@link WAIT_TRACK_MS}
 * wait that keeps its real time ("2 min later"). Steps that overlap in real
 * time are laid one after the other.
 */

/** A model call's text for the chat: the person's last message in its input, and its own reply. */
export interface ChatCallText {
  ask: string | null;
  reply: string | null;
}

export interface SessionChatInput {
  timeline: SessionTimeline;
  /** The timeline's turns: their end times, and the measured time of their searches. */
  turns: readonly Pick<TimelineTurn, "id" | "startedAt" | "endedAt" | "steps">[];
  /** Text by model call event id, or null when the project's content opt-in is off. */
  texts: ReadonlyMap<string, ChatCallText> | null;
}

export type ProblemKind = StepMark | "failed";

export interface ChatProblem {
  stepIndex: number;
  turnIndex: number;
  kinds: ProblemKind[];
  trackStartMs: number;
}

export interface WorkLine {
  /** Searches and tool calls. */
  actions: number;
  tookMs: number;
  /** Steps with at least one problem. */
  problems: number;
  label: string;
}

/** Where a turn's time went, from its steps' measured times. */
export interface TimeSplit {
  thinkingMs: number;
  toolMs: number;
  searchMs: number;
}

export interface ChatTurn {
  turnId: string;
  turnIndex: number;
  startedAt: string;
  endedAt: string;
  ask: string | null;
  reply: string | null;
  work: WorkLine;
  split: TimeSplit;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** The timeline steps of the turn, the turn step first. */
  stepIndexes: number[];
  trackStartMs: number;
  trackEndMs: number;
}

export type SegmentKind = "ask" | "model_call" | "search" | "tool_call" | "wait";

export interface TrackSegment {
  kind: SegmentKind;
  /** The timeline step, or null for a wait. */
  stepIndex: number | null;
  turnIndex: number;
  label: string;
  /** Real start, from the session's start. */
  realStartMs: number;
  /** Real duration, or null when it was not measured. */
  realMs: number | null;
  measured: boolean;
  trackStartMs: number;
  trackMs: number;
  problem: boolean;
  /** `events.id` of a model call, `trace_events.id` of a search or tool call; null for an ask or a wait. */
  eventId: string | null;
  /** A search's ranked results (tool ids), best first. */
  hits: string[];
}

/** One model call's numbers, for the context inspector (RC-284). */
export interface ChatCall {
  stepIndex: number;
  eventId: string;
  /** 1-based across the session. */
  callNumber: number;
  turnIndex: number;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  costUsd: number | null;
}

/** One tool-choice verdict in words, as the step-by-step view's decision chip. */
export interface ChatVerdict {
  tone: "good" | "bad";
  text: string;
}

/** A model call's context split (the RC-144 lens), by part, in tokens. */
export interface CallSplit {
  inputTokens: number;
  parts: Record<LensPart, number>;
}

export interface SessionChat {
  sessionId: string;
  textOff: boolean;
  turns: ChatTurn[];
  calls: ChatCall[];
  /** By step index; set by the loader, absent where the lens has no row. */
  splits?: Record<number, CallSplit>;
  /** By model call step index: the turn and 0-based call a What-if forks (RC-524); set by the loader. */
  forks?: Record<number, { turnId: string; call: number }>;
  /** By step index: why a tool choice was good or bad (RC-524); set by the loader, absent steps have none. */
  verdicts?: Record<number, ChatVerdict[]>;
  segments: TrackSegment[];
  problems: ChatProblem[];
  trackTotalMs: number;
  realTotalMs: number;
}

export const MIN_SEGMENT_MS = 300;
export const WAIT_THRESHOLD_MS = 30_000;
export const WAIT_TRACK_MS = 3_000;

const SPLIT_OF_STEP = {
  model_call: "thinkingMs",
  tool_call: "toolMs",
  search: "searchMs",
} as const;
const KIND_OF_STEP: Record<TimelineStep["kind"], SegmentKind> = {
  turn: "ask",
  model_call: "model_call",
  search: "search",
  tool_call: "tool_call",
};

export function buildSessionChat({ timeline, turns, texts }: SessionChatInput): SessionChat {
  const turnById = new Map(turns.map((turn) => [turn.id, turn]));
  const searchTook = new Map(
    turns.flatMap((turn) => turn.steps.map((step) => [step.traceEventId, step.tookMs] as const)),
  );
  const origin = Math.min(
    ...turns.map((turn) => turn.startedAt.getTime()),
    Number.POSITIVE_INFINITY,
  );
  const track = new TrackBuilder(Number.isFinite(origin) ? origin : 0);
  const chatTurns: ChatTurn[] = [];
  const problems: ChatProblem[] = [];

  for (const steps of stepsByTurn(timeline.steps)) {
    const head = steps[0]!;
    const turn = turnById.get(head.turnId);
    const startedAt = turn?.startedAt.getTime() ?? Date.parse(head.at);
    const endedAt = turn?.endedAt.getTime() ?? startedAt;
    const trackStartMs = track.advanceTo(startedAt, head.turnIndex);
    let problemSteps = 0;
    const split: TimeSplit = { thinkingMs: 0, toolMs: 0, searchMs: 0 };
    for (const step of steps) {
      const kinds = problemKinds(step);
      const realMs = durationOf(step, searchTook);
      if (step.kind !== "turn") split[SPLIT_OF_STEP[step.kind]] += realMs ?? 0;
      const segment = track.place(
        step,
        KIND_OF_STEP[step.kind],
        labelOf(step),
        realMs,
        kinds.length > 0,
      );
      if (kinds.length > 0) {
        problemSteps += 1;
        problems.push({
          stepIndex: step.index,
          turnIndex: step.turnIndex,
          kinds,
          trackStartMs: segment.trackStartMs,
        });
      }
    }
    const trackEndMs = track.advanceTo(endedAt, head.turnIndex);
    const actions = steps.filter(
      (step) => step.kind === "search" || step.kind === "tool_call",
    ).length;
    // A turn's calls can land after its recorded end (load.ts joins them up to two minutes later).
    const tookMs = Math.max(0, track.cursor - startedAt);
    const calls = steps.flatMap((step) =>
      step.kind === "model_call" ? [texts?.get(step.eventId)] : [],
    );
    chatTurns.push({
      turnId: head.turnId,
      turnIndex: head.turnIndex,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      ask: calls.find((text) => text?.ask)?.ask ?? null,
      reply: calls.findLast((text) => text?.reply)?.reply ?? null,
      work: {
        actions,
        tookMs,
        problems: problemSteps,
        label: workLabel(actions, tookMs, problemSteps),
      },
      split,
      inputTokens: sumOf(steps, (step) => (step.kind === "model_call" ? step.inputTokens : null)),
      outputTokens: sumOf(steps, (step) => (step.kind === "model_call" ? step.outputTokens : null)),
      costUsd: sumOf(steps, (step) => (step.kind === "model_call" ? step.costUsd : null)),
      stepIndexes: steps.map((step) => step.index),
      trackStartMs,
      trackEndMs,
    });
  }

  return {
    sessionId: timeline.sessionId,
    textOff: texts === null,
    turns: chatTurns,
    calls: timeline.steps
      .flatMap((step) => (step.kind === "model_call" ? [step] : []))
      .map((step, i) => ({
        stepIndex: step.index,
        eventId: step.eventId,
        callNumber: i + 1,
        turnIndex: step.turnIndex,
        model: step.model,
        inputTokens: step.inputTokens,
        outputTokens: step.outputTokens,
        latencyMs: step.latencyMs,
        costUsd: step.costUsd,
      })),
    segments: track.segments,
    problems,
    trackTotalMs: track.trackPos,
    realTotalMs: Math.max(0, track.cursor - track.origin),
  };
}

/** "11 s", "1 min 5 s", "1 h 5 min"; under a second is "<1 s". */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return "<1 s";
  const s = Math.round(ms / 1_000);
  if (s < 60) return `${s} s`;
  if (s < 3_600)
    return s % 60 === 0 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 60)} min ${s % 60} s`;
  const m = Math.round(s / 60);
  return m % 60 === 0 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** A step's time, finer than {@link formatDuration}: "154 ms", "2.3 s", then as formatDuration. */
export function formatStepTime(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)} s`;
  return formatDuration(ms);
}

/** A wait's label, rounded to its largest unit: "45 s later", "5 min later", "2 h later". */
export function formatWait(ms: number): string {
  const s = Math.round(ms / 1_000);
  if (s < 60) return `${s} s later`;
  if (s < 3_600) return `${Math.round(s / 60)} min later`;
  return `${Math.round(s / 3_600)} h later`;
}

/** Places segments on the track from left to right, collapsing long pauses. */
class TrackBuilder {
  readonly segments: TrackSegment[] = [];
  trackPos = 0;
  cursor: number;

  constructor(readonly origin: number) {
    this.cursor = origin;
  }

  /** Move the cursor to a real time; returns the track position there. */
  advanceTo(realT: number, turnIndex: number): number {
    const gap = realT - this.cursor;
    if (gap > WAIT_THRESHOLD_MS) {
      this.segments.push({
        kind: "wait",
        stepIndex: null,
        turnIndex,
        label: formatWait(gap),
        realStartMs: this.cursor - this.origin,
        realMs: gap,
        measured: true,
        trackStartMs: this.trackPos,
        trackMs: WAIT_TRACK_MS,
        problem: false,
        eventId: null,
        hits: [],
      });
      this.trackPos += WAIT_TRACK_MS;
    } else if (gap > 0) {
      this.trackPos += gap;
    }
    this.cursor = Math.max(this.cursor, realT);
    return this.trackPos;
  }

  place(
    step: TimelineStep,
    kind: SegmentKind,
    label: string,
    realMs: number | null,
    problem: boolean,
  ): TrackSegment {
    this.advanceTo(Date.parse(step.at), step.turnIndex);
    const segment: TrackSegment = {
      kind,
      stepIndex: step.index,
      turnIndex: step.turnIndex,
      label,
      realStartMs: this.cursor - this.origin,
      realMs,
      measured: realMs !== null,
      trackStartMs: this.trackPos,
      trackMs: Math.max(realMs ?? 0, MIN_SEGMENT_MS),
      problem,
      eventId:
        step.kind === "model_call" ? step.eventId : step.kind === "turn" ? null : step.traceEventId,
      hits: step.kind === "search" ? step.hitIds : [],
    };
    this.segments.push(segment);
    this.trackPos += segment.trackMs;
    this.cursor += realMs ?? 0;
    return segment;
  }
}

function stepsByTurn(steps: readonly TimelineStep[]): TimelineStep[][] {
  const out: TimelineStep[][] = [];
  for (const step of steps) {
    if (step.kind === "turn" || out.length === 0) out.push([step]);
    else out[out.length - 1]!.push(step);
  }
  return out;
}

function problemKinds(step: TimelineStep): ProblemKind[] {
  const kinds: ProblemKind[] =
    step.kind === "tool_call" && step.outcome === "error" ? ["failed"] : [];
  return [...kinds, ...step.marks];
}

function durationOf(
  step: TimelineStep,
  searchTook: ReadonlyMap<string, number | null>,
): number | null {
  switch (step.kind) {
    case "turn":
      return 0;
    case "model_call":
      return step.latencyMs;
    case "search":
      return searchTook.get(step.traceEventId) ?? null;
    case "tool_call":
      return step.tookMs;
  }
}

function labelOf(step: TimelineStep): string {
  switch (step.kind) {
    case "turn":
      return "Ask";
    case "model_call":
      return step.model ?? "Model call";
    case "search":
      return "Search";
    case "tool_call":
      return step.targetId ?? "Tool call";
  }
}

function sumOf(
  steps: readonly TimelineStep[],
  read: (step: TimelineStep) => number | null,
): number {
  return steps.reduce((total, step) => total + (read(step) ?? 0), 0);
}

function workLabel(actions: number, tookMs: number, problems: number): string {
  const parts = [
    actions === 0 ? "No actions" : `${actions} ${actions === 1 ? "action" : "actions"}`,
    formatDuration(tookMs),
  ];
  if (problems > 0) parts.push(`${problems} to check`);
  return parts.join(" · ");
}
