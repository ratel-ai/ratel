"use client";

import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { TASK_COLOR_CLASSES } from "@ratel/design-system/task-colors";
import { ArrowRight, Pause, Play, ScanSearch, TriangleAlert } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef } from "react";
import { bandColors } from "@/lib/views/session-chat/bands";
import {
  formatStepTime,
  type SessionChat,
  type TrackSegment,
} from "@/lib/views/session-chat/model";
import {
  axisTicks,
  nextProblem,
  segmentAt,
  stepAt,
  ZOOMS,
  type Zoom,
  zoomWindow,
} from "@/lib/views/session-chat/playback";
import { stepWords } from "./format";

/**
 * The session's time-scaled track (RC-283, A3, A4): each step as wide as its
 * duration, long waits shortened and hatched with their real time, the
 * playhead, play at 1×/2×/4×, zoom Fit/2×/4× that follows the playhead, and
 * "Next problem". Drag or scroll over the track to move; a click on a step
 * opens it. Keys (←/→, Space) are the chat view's.
 */

export const SPEEDS = [1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];

export interface SessionTrackProps {
  chat: SessionChat;
  t: number;
  onSeek: (t: number) => void;
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  speed: Speed;
  onSpeedChange: (speed: Speed) => void;
  zoom: Zoom;
  onZoomChange: (zoom: Zoom) => void;
  onOpenStep: (stepIndex: number) => void;
  /** Open the context inspector on the model call at the playhead. */
  onInspect: () => void;
  /** A line at one step, with its words (an eval run: where it differs from the last run). */
  marker?: TrackMarker;
  /** Steps the chosen steps view leaves out: drawn faint, in place, so the time stays true. */
  dimmed?: (segment: TrackSegment) => boolean;
}

export interface TrackMarker {
  stepIndex: number;
  label: string;
}

/** A click that moves less than this is a click, not a drag. */
const CLICK_PX = 4;
/** A block narrower than this (in % of the view) shows no label. */
const LABEL_MIN_PERCENT = 5;

const SEGMENT_CLASS: Record<TrackSegment["kind"], string> = {
  model_call: "bg-line-active",
  tool_call: "bg-fg-faint",
  search: "bg-line-strong",
  ask: "bg-success",
  user_message: "bg-success/60",
  code: "bg-info/50",
  handoff: "bg-warning/50",
  wait: "bg-[repeating-linear-gradient(-45deg,var(--color-line-strong)_0_2px,transparent_2px_6px)]",
};

const LEGEND = [
  { label: "Thinking", className: SEGMENT_CLASS.model_call },
  { label: "Tool call", className: SEGMENT_CLASS.tool_call },
  { label: "Tool search", className: SEGMENT_CLASS.search },
  { label: "Their message", className: SEGMENT_CLASS.ask },
  { label: "Waiting for them, shortened", className: SEGMENT_CLASS.wait },
];

/** With typed steps the track also draws code and handoffs. */
const TYPED_LEGEND = [
  ...LEGEND.slice(0, 2),
  { label: "Code", className: SEGMENT_CLASS.code },
  { label: "Handoff", className: SEGMENT_CLASS.handoff },
  ...LEGEND.slice(2),
];

export function SessionTrack({
  chat,
  t,
  onSeek,
  playing,
  onPlayingChange,
  speed,
  onSpeedChange,
  zoom,
  onZoomChange,
  onOpenStep,
  onInspect,
  marker,
  dimmed,
}: SessionTrackProps) {
  const total = chat.trackTotalMs;
  const view = zoomWindow(total, zoom, t);
  const width = view.endMs - view.startMs;
  const percent = (ms: number) => (width > 0 ? ((ms - view.startMs) / width) * 100 : 0);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; moved: boolean } | null>(null);
  const seekRef = useRef({ t, width, onSeek });
  useEffect(() => {
    seekRef.current = { t, width, onSeek };
  });

  const timeAt = (clientX: number) => {
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return t;
    const ms = view.startMs + ((clientX - rect.left) / rect.width) * width;
    return Math.min(Math.max(0, ms), total);
  };

  // Scrolling over the track moves the playhead; React's wheel listener is passive, so this one is added by hand.
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    function onWheel(event: WheelEvent) {
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (delta === 0) return;
      event.preventDefault();
      const { t: now, width: span, onSeek: seek } = seekRef.current;
      seek(now + (delta / 500) * span * 0.25);
    }
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { x: event.clientX, moved: false };
    onPlayingChange(false);
    onSeek(timeAt(event.clientX));
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    if (Math.abs(event.clientX - drag.current.x) >= CLICK_PX) drag.current.moved = true;
    onSeek(timeAt(event.clientX));
  }
  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const wasClick = drag.current && !drag.current.moved;
    drag.current = null;
    if (!wasClick) return;
    const at = timeAt(event.clientX);
    const step = segmentAt(chat, at)?.stepIndex ?? stepAt(chat, at);
    if (step !== null) onOpenStep(step);
  }

  const here = segmentAt(chat, t);
  const problem = here?.problem ? chat.problems.find((p) => p.stepIndex === here.stepIndex) : null;
  const next = nextProblem(chat, t);
  const ticks = axisTicks(view.startMs, view.endMs);
  const markerAt = marker
    ? chat.segments.find((s) => s.stepIndex === marker.stepIndex)?.trackStartMs
    : undefined;
  const bands = chat.bands ?? [];
  const colors = bandColors(bands);
  const typed = chat.segments.some((segment) => segment.publicKind !== undefined);

  return (
    <div data-session-track className="shrink-0 border-t border-line bg-raised px-4 pt-3 pb-2">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => {
            if (!playing && t >= total) onSeek(0);
            onPlayingChange(!playing);
          }}
        >
          {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
          {playing ? "Pause" : "Play"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Speed ${speed}×, change`}
          onClick={() => onSpeedChange(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!)}
        >
          {speed}×
        </Button>
        <span data-track-position className="text-ui tabular-nums text-fg">
          {formatStepTime(t)} <span className="text-fg-subtle">of {formatStepTime(total)}</span>
        </span>
        {/*
          What the playhead is on. It comes and goes as the playhead moves, so it must not
          decide where the controls sit: this box is a size container (it asks for no width
          of its own, it only takes what the row has left), and each label shows only when
          the box has room for it. The controls stay on one row whatever the playhead is on.
          A label with no room is hidden from the eye only (sr-only), so it is still read aloud.
        */}
        <div data-track-here className="@container flex min-w-0 flex-1 basis-0 items-center gap-2">
          {here && here.kind !== "wait" ? (
            <span className="sr-only @[14rem]:not-sr-only @[14rem]:flex @[14rem]:min-w-0">
              <span className="min-w-0 truncate text-ui text-fg-muted">
                · {stepWords(here)}{" "}
                {here.measured && here.realMs !== null ? formatStepTime(here.realMs) : ""}
              </span>
            </span>
          ) : null}
          {problem ? (
            <span className="sr-only @[5.5rem]:not-sr-only @[5.5rem]:flex @[5.5rem]:shrink-0">
              <span className="inline-flex items-center gap-1 text-ui whitespace-nowrap text-warning">
                <TriangleAlert aria-hidden className="size-3.5" />
                To check
              </span>
            </span>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div role="group" aria-label="Zoom" className="flex rounded-md border border-line">
            {ZOOMS.map((z) => (
              <Button
                key={z}
                size="sm"
                variant="ghost"
                aria-pressed={zoom === z}
                className={cn(
                  "rounded-none first:rounded-l-md last:rounded-r-md",
                  zoom === z && "bg-selected text-fg",
                )}
                onClick={() => onZoomChange(z)}
              >
                {z === 1 ? "Fit" : `${z}×`}
              </Button>
            ))}
          </div>
          <Button size="sm" variant="ghost" disabled={chat.calls.length === 0} onClick={onInspect}>
            <ScanSearch aria-hidden />
            Inspect context
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!next}
            onClick={() => {
              if (!next) return;
              onPlayingChange(false);
              onSeek(next.trackStartMs);
            }}
          >
            Next problem
            <ArrowRight aria-hidden />
          </Button>
        </div>
      </div>
      {bands.length > 0 ? (
        <div
          data-task-bands
          aria-label="Tasks in this session"
          role="list"
          className="relative mb-1 h-5 overflow-hidden"
        >
          {bands.map((band) => {
            const left = percent(band.trackStartMs);
            const w = width > 0 ? ((band.trackEndMs - band.trackStartMs) / width) * 100 : 0;
            if (left + w < 0 || left > 100) return null;
            const color = TASK_COLOR_CLASSES[colors.get(band.workflowId) ?? "neutral"];
            return (
              <div
                key={band.segmentId}
                role="listitem"
                data-task-band={band.workflowId}
                title={band.label}
                className={cn(
                  "absolute inset-y-0 flex min-w-1 items-center gap-1.5 overflow-hidden rounded-sm border-l-2 px-1.5 text-[11px] text-fg",
                  color.bgSubtle,
                  color.border,
                )}
                style={{ left: `${left}%`, width: `${w}%` }}
              >
                <span className="truncate">{band.label}</span>
              </div>
            );
          })}
        </div>
      ) : null}
      <div
        ref={viewport}
        role="slider"
        tabIndex={0}
        aria-label="Playhead"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={Math.round(t)}
        aria-valuetext={`${formatStepTime(t)} of ${formatStepTime(total)}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
        className="relative h-6 cursor-ew-resize touch-none overflow-hidden rounded-md outline-none select-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {chat.segments.map((segment, i) => {
          const left = percent(segment.trackStartMs);
          const w = width > 0 ? (segment.trackMs / width) * 100 : 0;
          if (left + w < 0 || left > 100) return null;
          const label =
            segment.kind === "wait"
              ? segment.label
              : segment.measured && segment.realMs !== null && segment.kind !== "ask"
                ? formatStepTime(segment.realMs)
                : "";
          return (
            <div
              key={`${segment.stepIndex ?? "wait"}-${i}`}
              data-segment={segment.kind}
              data-step={segment.stepIndex ?? undefined}
              title={
                segment.kind === "wait"
                  ? segment.label
                  : `${stepWords(segment)} · ${segment.measured ? formatStepTime(segment.realMs ?? 0) : "time not measured"}`
              }
              className={cn(
                "absolute inset-y-0.5 flex items-center justify-center overflow-hidden rounded-sm border-r-2 border-raised text-[11px] tabular-nums",
                SEGMENT_CLASS[segment.kind],
                segment.problem && "ring-1 ring-warning ring-inset",
                segment.kind === "wait" ? "text-fg-subtle" : "text-fg",
                !segment.measured && "opacity-60",
                dimmed?.(segment) && "opacity-25",
              )}
              style={{ left: `${left}%`, width: `${w}%` }}
            >
              {w >= LABEL_MIN_PERCENT ? <span className="truncate px-1">{label}</span> : null}
            </div>
          );
        })}
        {marker && markerAt !== undefined && percent(markerAt) >= 0 && percent(markerAt) <= 100 ? (
          <div
            data-track-marker={marker.stepIndex}
            title={marker.label}
            className="pointer-events-none absolute inset-y-0 border-l-2 border-dashed border-info"
            style={{ left: `${percent(markerAt)}%` }}
          />
        ) : null}
        <div
          data-playhead
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-accent-mark"
          style={{ left: `${Math.min(Math.max(percent(t), 0), 100)}%` }}
        />
      </div>
      <div aria-hidden className="relative mt-0.5 h-4 text-[11px] tabular-nums text-fg-subtle">
        {ticks.map((tick) => (
          <span
            key={tick}
            className="absolute -translate-x-1/2 first:translate-x-0"
            style={{ left: `${percent(tick)}%` }}
          >
            {formatStepTime(tick)}
          </span>
        ))}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-subtle">
        {(typed ? TYPED_LEGEND : LEGEND).map((item) => (
          <span key={item.label} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cn("size-2.5 rounded-sm", item.className)} />
            {item.label}
          </span>
        ))}
        {marker ? (
          <span className="inline-flex items-center gap-1.5 text-info">
            <span aria-hidden className="h-2.5 border-l-2 border-dashed border-info" />
            {marker.label}
          </span>
        ) : null}
        <span className="ml-auto">Drag, scroll or use ← → to move through it</span>
      </div>
    </div>
  );
}
