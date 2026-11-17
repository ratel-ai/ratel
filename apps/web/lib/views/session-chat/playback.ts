import type { ChatTurn, SessionChat, TrackSegment } from "./model";

/**
 * Moving through the session chat's track (RC-283): which step is under the
 * playhead, where ←/→ and "Next problem" take it, what a zoom shows, and what
 * the chat shows at a playhead position. Positions are track ms (see
 * `model.ts`). Pure.
 */

export type Zoom = 1 | 2 | 4;

export type TurnPhase =
  | { phase: "future"; turn: ChatTurn }
  | { phase: "done"; turn: ChatTurn }
  | {
      phase: "live";
      turn: ChatTurn;
      /** Steps finished before the playhead. */
      done: TrackSegment[];
      /** The step under the playhead, or null between steps. */
      current: TrackSegment | null;
      currentElapsedMs: number;
      /** Track time since the turn began. */
      elapsedMs: number;
    };

export const ZOOMS: readonly Zoom[] = [1, 2, 4];

/** The segment under the playhead, or null outside every segment. */
export function segmentAt(chat: SessionChat, t: number): TrackSegment | null {
  return chat.segments.find((s) => t >= s.trackStartMs && t < s.trackStartMs + s.trackMs) ?? null;
}

/** The step under the playhead; on a wait or a pause, the last step started before it. */
export function stepAt(chat: SessionChat, t: number): number | null {
  const steps = chat.segments.filter((s) => s.stepIndex !== null);
  if (steps.length === 0) return null;
  const started = steps.filter((s) => s.trackStartMs <= t);
  return (started.at(-1) ?? steps[0]!).stepIndex;
}

/** Where ← (-1) or → (1) takes the playhead: the previous or next step's start (the track's end after the last). */
export function adjacentStop(chat: SessionChat, t: number, direction: 1 | -1): number {
  const stops = [
    ...chat.segments.filter((s) => s.kind !== "wait").map((s) => s.trackStartMs),
    chat.trackTotalMs,
  ];
  if (direction === 1) return stops.find((stop) => stop > t) ?? chat.trackTotalMs;
  return stops.filter((stop) => stop < t).at(-1) ?? 0;
}

/** The first flagged step after the playhead, else the first one; null when none is flagged. */
export function nextProblem(chat: SessionChat, t: number): SessionChat["problems"][number] | null {
  return chat.problems.find((p) => p.trackStartMs > t) ?? chat.problems[0] ?? null;
}

/** The part of the track a zoom shows: all of it at Fit, else 1/zoom of it centered on the playhead, kept inside the track. */
export function zoomWindow(
  totalMs: number,
  zoom: Zoom,
  t: number,
): { startMs: number; endMs: number } {
  const width = totalMs / zoom;
  const startMs = Math.min(Math.max(0, t - width / 2), totalMs - width);
  return { startMs, endMs: startMs + width };
}

/** Each turn at the playhead: done, live (with its steps so far), or not yet reached. */
export function chatStateAt(chat: SessionChat, t: number): TurnPhase[] {
  return chat.turns.map((turn) => {
    if (t >= turn.trackEndMs) return { phase: "done", turn };
    if (t < turn.trackStartMs) return { phase: "future", turn };
    const steps = chat.segments.filter(
      (s) => s.turnIndex === turn.turnIndex && s.kind !== "ask" && s.kind !== "wait",
    );
    const current =
      steps.find((s) => t >= s.trackStartMs && t < s.trackStartMs + s.trackMs) ?? null;
    return {
      phase: "live",
      turn,
      done: steps.filter((s) => s.trackStartMs + s.trackMs <= t),
      current,
      currentElapsedMs: current ? t - current.trackStartMs : 0,
      elapsedMs: t - turn.trackStartMs,
    };
  });
}

/** Where a replay with no `?t=` starts: the end (the whole chat), or with views v3 (RC-524) the first message. */
export interface PlayheadDefault {
  fromStart?: boolean;
}

/** `?t=` as a playhead in the track; missing or unreadable is the default (the end, or the start with `fromStart`). */
export function parsePlayhead(
  value: string | null | undefined,
  totalMs: number,
  { fromStart = false }: PlayheadDefault = {},
): number {
  const n = value == null || value === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(n)) return fromStart ? 0 : totalMs;
  return Math.min(Math.max(0, Math.round(n)), totalMs);
}

/** The playhead as `?t=`: null at the default, so the URL stays clean and `parsePlayhead` reads it back. */
export function playheadParam(
  t: number,
  totalMs: number,
  { fromStart = false }: PlayheadDefault = {},
): string | null {
  const at = Math.round(t);
  if (fromStart ? at <= 0 : at >= totalMs) return null;
  return String(Math.min(at, totalMs));
}

/** `?zoom=`: 2 or 4, else Fit. */
export function parseZoom(value: string | null | undefined): Zoom {
  return value === "2" ? 2 : value === "4" ? 4 : 1;
}

const TICK_STEPS = [
  100, 250, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
];

/** Axis ticks for a window: a round step that gives about six labels, from the first multiple at or after its start. */
export function axisTicks(startMs: number, endMs: number, target = 6): number[] {
  const width = endMs - startMs;
  if (!(width > 0)) return [startMs];
  const step = TICK_STEPS.find((s) => width / s <= target) ?? TICK_STEPS.at(-1)!;
  const ticks: number[] = [];
  for (let tick = Math.ceil(startMs / step) * step; tick <= endMs; tick += step) ticks.push(tick);
  return ticks;
}

export type KeyAction = "close" | "previous" | "next" | "toggle_play";

/** What a key does in the chat: Esc closes the panel, ←/→ step, Space plays. Nothing while typing or with a modifier. */
export function keyAction(
  key: string,
  { typing, modifier }: { typing: boolean; modifier: boolean },
): KeyAction | null {
  if (typing || modifier) return null;
  switch (key) {
    case "Escape":
      return "close";
    case "ArrowLeft":
      return "previous";
    case "ArrowRight":
      return "next";
    case " ":
      return "toggle_play";
    default:
      return null;
  }
}
