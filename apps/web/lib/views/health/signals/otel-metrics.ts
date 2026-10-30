import { emptyOtelDay, type OtelDay } from "@/lib/readings/trace-signals/signals/otel-day";
import {
  type DayBucket,
  rateInterval,
  type TileMeta,
  type TileReading,
  type TileWindow,
  tilesWith,
  totalOver,
  windowDays,
} from "@/lib/readings/trace-signals/signals/project-metrics";
import { wilson } from "@/lib/readings/trace-signals/signals/severity";
import type {
  CaptureLevel,
  CaptureUnlock,
  HealthTile,
  TurnShapeView,
} from "@/lib/readings/trace-signals/view";
import { OTEL_TURN_SHAPE_KINDS, type OtelTurnShapeKind } from "@/lib/readings/trace-signals/view";

/**
 * The band, shapes and capture nudge of a project that only sends
 * OpenTelemetry. There is no Ratel search to score, so first try, detours
 * and junk are not read; the band reads what OTel does carry: whether runs
 * finished, failed calls, repeats and retries, and model round trips.
 */

const fmt = (n: number): string => n.toLocaleString("en-US");

const COMPLETED: TileMeta = { key: "completed", label: "Completed", unit: "share", upIsGood: true };
const FAILED: TileMeta = {
  key: "failed_calls",
  label: "Failed calls",
  unit: "share",
  upIsGood: false,
};
const WASTED: TileMeta = {
  key: "wasted_calls",
  label: "Wasted calls",
  unit: "per_100_turns",
  upIsGood: false,
};
const ROUND_TRIPS: TileMeta = {
  key: "round_trips",
  label: "Model round trips",
  unit: "per_turn",
  upIsGood: false,
};

function readOtelTile(key: HealthTile["key"], bucket: DayBucket): TileReading {
  const o = bucket.otel ?? emptyOtelDay();
  switch (key) {
    case "completed":
      return {
        value: o.turns > 0 ? o.completed / o.turns : null,
        interval: wilson(o.completed, o.turns),
        n: o.turns,
        sub: `${fmt(o.completed)} of ${fmt(o.turns)} runs ended without a failed call.`,
      };
    case "failed_calls":
      return {
        value: o.calls > 0 ? o.failedCalls / o.calls : null,
        interval: wilson(o.failedCalls, o.calls),
        n: o.calls,
        sub: `${fmt(o.failedCalls)} of ${fmt(o.calls)} tool calls failed.`,
      };
    case "wasted_calls":
      return {
        value: o.turns > 0 ? (o.wasted / o.turns) * 100 : null,
        interval: rateInterval(o.wasted, o.turns),
        n: o.turns,
        sub: `${fmt(o.wasted)} repeats and retries of the same tool.`,
      };
    case "round_trips":
      return {
        value: o.roundTripTurns > 0 ? o.roundTrips / o.roundTripTurns : null,
        interval: null,
        n: o.roundTripTurns,
        sub: `${fmt(o.roundTrips)} model calls over ${fmt(o.roundTripTurns)} runs.`,
      };
    default:
      return { value: null, interval: null, n: 0, sub: "" };
  }
}

/**
 * The OpenTelemetry band over a window: completed, failed calls, wasted
 * calls, and model round trips when any run in the window sent its model
 * calls (without them the tile would only ever read a dash, so it is left out
 * and the band has three tiles).
 */
export function otelTilesFor(buckets: readonly DayBucket[], w: TileWindow): HealthTile[] {
  const total = totalOver(buckets, windowDays(w.end, w.days));
  const roundTrips = (total.otel?.roundTripTurns ?? 0) > 0;
  const metas = [COMPLETED, FAILED, WASTED, ...(roundTrips ? [ROUND_TRIPS] : [])];
  return tilesWith(buckets, w, metas, readOtelTile);
}

const OTEL_SHAPE_COPY: Record<OtelTurnShapeKind, { label: string; description: string }> = {
  otel_direct: { label: "Direct", description: "One tool call, and it worked." },
  otel_chain: {
    label: "Chain",
    description: "Two or more tool calls, one after another, all worked.",
  },
  otel_retry: { label: "Retry", description: "A tool failed, and the agent ran it again." },
  otel_switched: {
    label: "Switched",
    description: "A tool failed, so the agent tried a different one.",
  },
  otel_failed: { label: "Failed", description: "The last tool call failed." },
};

/** The five OpenTelemetry shapes over a window's total, sorted by count (ties in catalog order). */
export function otelShapesFor(total: DayBucket): TurnShapeView[] {
  const shapes = total.otel?.shapes;
  const shaped = OTEL_TURN_SHAPE_KINDS.reduce((sum, kind) => sum + (shapes?.[kind] ?? 0), 0);
  return OTEL_TURN_SHAPE_KINDS.map((shape) => {
    const count = shapes?.[shape] ?? 0;
    return { shape, ...OTEL_SHAPE_COPY[shape], count, share: shaped === 0 ? 0 : count / shaped };
  }).sort((a, b) => b.count - a.count);
}

/** Half or more of the runs carry it: the option counts as on. */
const isOn = (count: number, turns: number): boolean => turns > 0 && count * 2 >= turns;

/** `content` once results are captured for half the runs or more; `tools` otherwise. */
export function otelCaptureLevel(total: DayBucket): CaptureLevel {
  const o = total.otel ?? emptyOtelDay();
  return isOn(o.resultTurns, o.turns) ? "content" : "tools";
}

/** The OpenTelemetry options the nudge can name, each with what it adds. */
export const OTEL_UNLOCKS = {
  content: {
    key: "otel_content",
    label: "Empty results and the asks behind each run",
    description:
      "Turn on content capture so Ratel sees what each tool returned and what was asked. It can then flag tools that often come back empty and name your tasks from real asks.",
  },
  definitions: {
    key: "otel_tool_definitions",
    label: "Tools offered but never used",
    description:
      "Send the tool definitions with each model call (gen_ai.tool.definitions), and Ratel lists the tools the model is offered every time and never calls.",
  },
  conversation: {
    key: "otel_conversation_id",
    label: "What each tool needs first, across runs",
    description:
      "Set a conversation id (gen_ai.conversation.id or session.id) on your spans, and Ratel links the runs of one conversation to see which tool needs another one first.",
  },
} as const satisfies Record<string, CaptureUnlock>;

/** The options a project has not turned on yet, as the nudge's rows; empty once all are on. */
export function otelCaptureUnlocks(total: DayBucket): CaptureUnlock[] {
  const o: OtelDay = total.otel ?? emptyOtelDay();
  if (o.turns === 0) return [];
  return [
    ...(isOn(o.resultTurns, o.turns) ? [] : [OTEL_UNLOCKS.content]),
    ...(isOn(o.menuTurns, o.turns) ? [] : [OTEL_UNLOCKS.definitions]),
    ...(isOn(o.sessionTurns, o.turns) ? [] : [OTEL_UNLOCKS.conversation]),
  ];
}
