"use client";

import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { usePeek } from "@ratel/design-system/panel";
import { isTypingTarget } from "@ratel/design-system/peek";
import { Callout } from "@ratel/design-system/states";
import { Check, Ellipsis, ListChecks, TriangleAlert, Wrench } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WhatIfSetup } from "@/components/console/session-replay/SessionTimeline";
import { createUrlWriter, withQueryUpdates } from "@/lib/synthesis/traces/v2/url-writer";
import type { TrackBookmark } from "@/lib/views/health/hallucinations/session-bookmarks";
import type { PanelChat, PanelChatTurn } from "@/lib/views/session-chat/actions";
import {
  type ChatTurn,
  formatStepTime,
  type SessionChat,
  type TrackSegment,
} from "@/lib/views/session-chat/model";
import type { StepContentSource } from "@/lib/views/session-chat/panel-client";
import { type ChatPeek, chatPeekId, parseChatPeek } from "@/lib/views/session-chat/peek";
import {
  adjacentStop,
  chatStateAt,
  keyAction,
  parsePlayhead,
  parseZoom,
  playheadParam,
  type TurnPhase,
  type Zoom,
} from "@/lib/views/session-chat/playback";
import { clockTime, segmentTime, stepWords } from "./format";
import { SessionChatPanel } from "./SessionChatPanel";
import { SessionTrack, type Speed, type TrackMarker } from "./SessionTrack";

/**
 * The session as a chat (RC-282, RC-283; A1–A5, A9): the person's messages on
 * the right, the agent's replies on the left, and the agent's work between
 * them as one line, over a time-scaled track. The chat shows the session at
 * the playhead: a turn in progress lists its steps so far with a running
 * timer, and collapses into its work line when it ends ("Show actions" opens
 * them again). A click opens the side panel, which pushes the chat aside.
 * The panel is `?peek=`, the playhead `?t=` and the zoom `?zoom=`; Esc closes
 * the panel, ←/→ move a step, Space plays.
 *
 * `synced` is the one replay of views v3 (RC-524): with no `?t=` it plays from
 * the first message, the first model call's inspector is open (an explicit
 * `?peek=` wins), and the two move together: the playhead moves the inspector
 * to the call under it, and opening a call (Previous / Next call, a click)
 * moves the playhead to that call's start, where the playhead already points
 * at it, so neither direction triggers the other again.
 */

/** What the inspector needs to fork a model call: the targets come with the chat. */
export type ChatWhatIf = Omit<WhatIfSetup, "targets">;

/** Extra actions under one step in the inspector (an eval run's edit and Simulate again). */
export type InspectorActions = (segment: TrackSegment) => ReactNode;

export interface SessionChatViewProps {
  projectId: string;
  chat: SessionChat;
  /** Project settings, where an admin turns message text on. */
  settingsHref: string;
  /**
   * Keep the playhead and zoom in the URL (`?t=`, `?zoom=`), as the console
   * page does. Off in an MCP view, which has no URL to share and keeps only
   * the open panel in its in-memory location.
   */
  syncUrl?: boolean;
  /** Overrides the frame's own height, for a container that sets it (an MCP view in fullscreen). */
  className?: string;
  /**
   * How the side panel opens. "push" (the page) sits beside the chat and pushes
   * it aside. "overlay" (a narrow frame, such as an MCP view) slides over the
   * chat from the right, over a scrim, so the chat keeps its width; a click on
   * the scrim, Esc or Close closes it.
   */
  panelMode?: "push" | "overlay";
  /** Views v3: play from the start, the inspector open, and the two in sync. */
  synced?: boolean;
  /** What if… in the model call inspector; absent, the inspector has none. */
  whatIf?: ChatWhatIf;
  /** Where the inspector reads a step's content; absent, from the trace tables. */
  source?: StepContentSource;
  /** Actions under a step in the inspector; absent, the inspector has none. */
  inspectorActions?: InspectorActions;
  /** A line on the track at one step; absent, none. */
  marker?: TrackMarker;
  /** The session's hallucinations on the track; the one the reader came from is where the replay opens. */
  bookmarks?: readonly TrackBookmark[];
  /** "Open full trace" on a work line; off for a chat with no trace (an eval run). */
  traceLinks?: boolean;
}

export function SessionChatView({
  projectId,
  chat,
  settingsHref,
  synced = false,
  whatIf,
  source,
  inspectorActions,
  marker,
  bookmarks = [],
  traceLinks = true,
  syncUrl = true,
  className,
  panelMode = "push",
}: SessionChatViewProps) {
  const { id, open: openPeek, close: closePeek } = usePeek();
  // Closed once, the default inspector stays closed until a click opens a panel.
  const [dismissed, setDismissed] = useState(false);
  // Opened from a hallucination, the replay starts on its step; else on the first model call.
  const startStep = bookmarks.find((bookmark) => bookmark.current)?.stepIndex;
  const firstCall = startStep ?? chat.calls[0]?.stepIndex;
  const peek =
    parseChatPeek(id) ??
    (synced && !dismissed && firstCall !== undefined
      ? ({ kind: "step", stepIndex: firstCall } as const)
      : null);
  const open = (next: ChatPeek) => {
    // Synced, a model call puts the playhead at its start: the follow below then already points at it.
    const start =
      synced && next.kind === "step" && chat.calls.some((c) => c.stepIndex === next.stepIndex)
        ? callStart(chat, next.stepIndex)
        : null;
    if (start !== null) setT(start);
    openPeek(chatPeekId(next));
  };
  const close = useCallback(() => {
    setDismissed(true);
    closePeek();
  }, [closePeek]);
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const total = chat.trackTotalMs;
  const [t, setT] = useState(() =>
    searchParams.get("t") === null && startStep !== undefined
      ? (callStart(chat, startStep) ?? 0)
      : parsePlayhead(searchParams.get("t"), total, { fromStart: synced }),
  );
  const [zoom, setZoom] = useState<Zoom>(() => parseZoom(searchParams.get("zoom")));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [showActions, setShowActions] = useState(false);
  const [follow, setFollow] = useState(synced);
  // Following starts when the playhead leaves where the page opened, or when someone ticks it.
  const [startT] = useState(t);
  const [followTicked, setFollowTicked] = useState(false);
  const onFollowChange = (next: boolean) => {
    setFollow(next);
    setFollowTicked(next);
  };
  const seek = (next: number) => setT(Math.min(Math.max(0, next), total));

  // The playhead and zoom follow into the URL once they rest (Safari caps replaceState).
  const writer = useMemo(
    () =>
      createUrlWriter((updates) =>
        window.history.replaceState(
          null,
          "",
          `${pathname}${withQueryUpdates(window.location.search, updates)}`,
        ),
      ),
    [pathname],
  );
  const firstWrite = useRef(true);
  useEffect(() => {
    if (firstWrite.current || !syncUrl) {
      firstWrite.current = false;
      return;
    }
    writer.set({
      t: playheadParam(t, total, { fromStart: synced }),
      zoom: zoom === 1 ? null : String(zoom),
    });
  }, [t, zoom, total, writer, synced, syncUrl]);
  useEffect(() => () => writer.cancel(), [writer]);

  const playhead = useRef(t);
  useEffect(() => {
    playhead.current = t;
  }, [t]);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = Math.min(playhead.current + (now - last) * speed, total);
      last = now;
      playhead.current = next;
      setT(next);
      if (next >= total) setPlaying(false);
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, total]);

  const isOpen = peek !== null;
  const keys = useRef({ t, playing, isOpen });
  useEffect(() => {
    keys.current = { t, playing, isOpen };
  });
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const action = keyAction(event.key, {
        typing: isTypingTarget(event.target),
        modifier: event.metaKey || event.ctrlKey || event.altKey,
      });
      const now = keys.current;
      if (action === "close" && now.isOpen) {
        event.preventDefault();
        close();
      } else if (action === "previous" || action === "next") {
        event.preventDefault();
        setPlaying(false);
        setT(adjacentStop(chat, now.t, action === "next" ? 1 : -1));
      } else if (action === "toggle_play") {
        // Space on a focused button presses it; leave that to the button.
        if (event.target instanceof HTMLElement && event.target.closest("button, a")) return;
        event.preventDefault();
        if (!now.playing && now.t >= total) setT(0);
        setPlaying(!now.playing);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chat, close, total]);

  // "Follow the playhead": an open model call moves to the call at the playhead.
  const followedCall =
    follow &&
    (followTicked || t !== startT) &&
    peek?.kind === "step" &&
    chat.calls.some((c) => c.stepIndex === peek.stepIndex)
      ? callAt(chat, t)
      : null;
  const openStep = peek?.kind === "step" ? peek.stepIndex : null;
  useEffect(() => {
    if (followedCall !== null && followedCall !== openStep)
      openPeek(chatPeekId({ kind: "step", stepIndex: followedCall }));
  }, [followedCall, openStep, openPeek]);

  const phases = chatStateAt(chat, t);
  // While it plays or steps, the chat keeps its newest line in view.
  const scroller = useRef<HTMLDivElement>(null);
  const shownTurns = phases.filter((phase) => phase.phase !== "future").length;
  const liveSteps = phases.reduce(
    (n, phase) => n + (phase.phase === "live" ? phase.done.length + 1 : 0),
    0,
  );
  useEffect(() => {
    if (t >= total) return;
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [shownTurns, liveSteps, t, total]);

  return (
    <div
      className={cn(
        "flex h-[min(52rem,calc(100dvh-10rem))] min-h-[32rem] overflow-hidden rounded-xl border border-line bg-app",
        panelMode === "overlay" && "relative",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            <div className="-mt-2 flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={showActions}
                onClick={() => setShowActions(!showActions)}
              >
                <ListChecks aria-hidden />
                {showActions ? "Hide actions" : "Show actions"}
              </Button>
            </div>
            {chat.textOff ? (
              <Callout tone="info">
                Message text is off for this project, so the steps show without the words. An admin
                can{" "}
                <a href={settingsHref} className="underline underline-offset-2 hover:text-fg">
                  turn it on in Settings
                </a>
                .
              </Callout>
            ) : null}
            {chat.turns.length > 0 ? <DaySeparator at={chat.turns[0]!.startedAt} /> : null}
            {phases.map((phase) =>
              phase.phase === "future" ? null : (
                <TurnBlock
                  key={phase.turn.turnId}
                  chat={chat}
                  phase={phase}
                  textOff={chat.textOff}
                  showActions={showActions}
                  peek={peek}
                  onOpen={open}
                />
              ),
            )}
          </div>
        </div>
        <SessionTrack
          chat={chat}
          t={t}
          onSeek={seek}
          playing={playing}
          onPlayingChange={setPlaying}
          speed={speed}
          onSpeedChange={setSpeed}
          zoom={zoom}
          onZoomChange={setZoom}
          onOpenStep={(stepIndex) => open({ kind: "step", stepIndex })}
          onInspect={() => {
            const call = callAt(chat, t) ?? chat.calls[0]?.stepIndex;
            if (call !== undefined) open({ kind: "step", stepIndex: call });
          }}
          marker={marker}
          bookmarks={bookmarks}
        />
      </div>
      {peek && panelMode === "push" ? (
        <SessionChatPanel
          projectId={projectId}
          chat={chat}
          peek={peek}
          follow={follow}
          onFollowChange={onFollowChange}
          whatIf={whatIf}
          source={source}
          inspectorActions={inspectorActions}
          traceLinks={traceLinks}
          onOpen={open}
          onClose={close}
        />
      ) : null}
      {peek && panelMode === "overlay" ? (
        <>
          <div
            aria-hidden
            data-chat-scrim
            className="absolute inset-0 z-10 bg-scrim"
            onClick={close}
          />
          <div
            data-chat-overlay
            className="absolute inset-y-0 right-0 z-10 flex w-full max-w-[28rem] shadow-dialog"
          >
            <SessionChatPanel
              projectId={projectId}
              chat={chat}
              peek={peek}
              follow={follow}
              onFollowChange={onFollowChange}
              whatIf={whatIf}
              source={source}
              inspectorActions={inspectorActions}
              traceLinks={traceLinks}
              onOpen={open}
              onClose={close}
              className="w-full"
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The whole session as chat, at rest (RC-503): every turn's message, its work
 * line and its reply, in order, each turn linking to its own trace. The
 * Sessions tab's side panel shows it; the replay page plays it.
 */
export function SessionChatTranscript({
  chat,
  turnHref,
}: {
  chat: PanelChat;
  turnHref: (turn: PanelChatTurn) => string | null;
}) {
  if (chat.turns.length === 0)
    return <p className="text-sm text-fg-muted">This session has no finished turn yet.</p>;
  return (
    <ol aria-label="Session chat" className="flex flex-col gap-3" data-session-transcript>
      {chat.textOff ? (
        <Callout tone="info">
          Message text is off for this project, so the turns show without the words.
        </Callout>
      ) : null}
      <DaySeparator at={chat.turns[0]!.startedAt} />
      {chat.turns.map((turn) => {
        const href = turnHref(turn);
        return (
          <li
            key={turn.turnIndex}
            className="flex flex-col gap-2"
            data-transcript-turn={turn.turnIndex}
          >
            <Bubble side="person" text={turn.ask} textOff={chat.textOff} at={turn.startedAt} />
            <div className="flex flex-wrap items-center gap-2 text-ui text-fg-muted">
              <Wrench aria-hidden className="size-3.5" />
              <span className="tabular-nums">{turn.work.label}</span>
              {href ? (
                <Link
                  href={href}
                  className="ml-auto text-xs text-fg-muted underline decoration-line-strong underline-offset-4 hover:text-fg"
                  data-turn-link={turn.turnIndex}
                >
                  Open turn {turn.turnIndex}
                </Link>
              ) : null}
            </div>
            {turn.reply !== null || chat.textOff ? (
              <Bubble side="agent" text={turn.reply} textOff={chat.textOff} at={turn.endedAt} />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function TurnBlock({
  chat,
  phase,
  textOff,
  showActions,
  peek,
  onOpen,
}: {
  chat: SessionChat;
  phase: Exclude<TurnPhase, { phase: "future" }>;
  textOff: boolean;
  showActions: boolean;
  peek: ChatPeek | null;
  onOpen: (peek: ChatPeek) => void;
}) {
  const { turn } = phase;
  const selected = (kind: "ask" | "reply" | "work") =>
    peek?.kind === kind && peek.turnIndex === turn.turnIndex;
  return (
    <>
      <Bubble
        side="person"
        text={turn.ask}
        textOff={textOff}
        at={turn.startedAt}
        selected={selected("ask")}
        onClick={() => onOpen({ kind: "ask", turnIndex: turn.turnIndex })}
      />
      {phase.phase === "live" ? (
        <ActionList
          heading={
            <>
              <Ellipsis aria-hidden className="size-3.5 animate-pulse" />
              Working · <span className="tabular-nums">{formatStepTime(phase.elapsedMs)}</span>
            </>
          }
          done={phase.done}
          current={phase.current}
          currentElapsedMs={phase.currentElapsedMs}
          onOpen={onOpen}
        />
      ) : (
        <>
          <WorkLineButton
            turn={turn}
            selected={selected("work")}
            onClick={() => onOpen({ kind: "work", turnIndex: turn.turnIndex })}
          />
          {showActions ? (
            <ActionList
              done={turnSteps(chat, turn)}
              current={null}
              currentElapsedMs={0}
              onOpen={onOpen}
            />
          ) : null}
          {turn.reply !== null || textOff ? (
            <Bubble
              side="agent"
              text={turn.reply}
              textOff={textOff}
              at={turn.endedAt}
              selected={selected("reply")}
              onClick={() => onOpen({ kind: "reply", turnIndex: turn.turnIndex })}
            />
          ) : null}
        </>
      )}
    </>
  );
}

/** The steps of a turn so far (A5): each done step with its time, and the current one with a running timer. */
function ActionList({
  heading,
  done,
  current,
  currentElapsedMs,
  onOpen,
}: {
  heading?: ReactNode;
  done: readonly TrackSegment[];
  current: TrackSegment | null;
  currentElapsedMs: number;
  onOpen: (peek: ChatPeek) => void;
}) {
  return (
    <div
      data-action-list={current ? "live" : "done"}
      className="flex w-full max-w-md flex-col self-start rounded-xl border border-line bg-raised px-3 py-2"
    >
      {heading ? (
        <div className="mb-1 flex items-center gap-1.5 text-ui text-fg-muted">{heading}</div>
      ) : null}
      <ol className="flex flex-col">
        {done.map((segment) => (
          <ActionRow
            key={segment.stepIndex}
            segment={segment}
            time={segmentTime(segment)}
            onOpen={onOpen}
          />
        ))}
        {current ? (
          <ActionRow
            segment={current}
            time={formatStepTime(currentElapsedMs)}
            running
            onOpen={onOpen}
          />
        ) : null}
      </ol>
      {done.length === 0 && !current ? (
        <p className="text-ui text-fg-subtle">No step yet.</p>
      ) : null}
    </div>
  );
}

function ActionRow({
  segment,
  time,
  running = false,
  onOpen,
}: {
  segment: TrackSegment;
  time: string;
  running?: boolean;
  onOpen: (peek: ChatPeek) => void;
}) {
  return (
    <li data-action-row={running ? "running" : "done"}>
      <button
        type="button"
        onClick={() =>
          segment.stepIndex !== null && onOpen({ kind: "step", stepIndex: segment.stepIndex })
        }
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-ui outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
      >
        {running ? (
          <Ellipsis aria-label="Running" className="size-3.5 animate-pulse text-fg-muted" />
        ) : segment.problem ? (
          <TriangleAlert aria-label="To check" className="size-3.5 text-warning" />
        ) : (
          <Check aria-hidden className="size-3.5 text-success" />
        )}
        <span className={cn("min-w-0 flex-1 truncate", running ? "text-fg" : "text-fg-muted")}>
          {stepWords(segment)}
        </span>
        <span className={cn("tabular-nums", running ? "text-fg" : "text-fg-subtle")}>{time}</span>
      </button>
    </li>
  );
}

/** Where a step starts on the track, or null when the chat has no such step. */
function callStart(chat: SessionChat, stepIndex: number): number | null {
  return chat.segments.find((s) => s.stepIndex === stepIndex)?.trackStartMs ?? null;
}

/** The model call at the playhead: the last one started by then (step index), or null before the first. */
function callAt(chat: SessionChat, t: number): number | null {
  const started = chat.calls.filter(
    (c) => (chat.segments.find((s) => s.stepIndex === c.stepIndex)?.trackStartMs ?? Infinity) <= t,
  );
  return started.at(-1)?.stepIndex ?? null;
}

function turnSteps(chat: SessionChat, turn: ChatTurn): TrackSegment[] {
  return chat.segments.filter(
    (s) => s.turnIndex === turn.turnIndex && s.kind !== "ask" && s.kind !== "wait",
  );
}

function Bubble({
  side,
  text,
  textOff,
  at,
  selected = false,
  onClick,
}: {
  side: "person" | "agent";
  text: string | null;
  textOff: boolean;
  at: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  const person = side === "person";
  const className = cn(
    "flex max-w-[80%] flex-col gap-1 rounded-xl border px-3.5 py-2.5 text-left text-sm",
    onClick && "outline-none focus-visible:ring-2 focus-visible:ring-focus",
    person ? "self-end border-line-strong bg-selected" : "self-start border-line bg-raised",
    selected && "border-line-active",
  );
  const body = (
    <>
      {textOff ? (
        <span aria-label="Message text is off" className="flex w-56 flex-col gap-1.5 py-1">
          <span className="h-2 w-full rounded-full bg-hover" />
          <span className="h-2 w-2/3 rounded-full bg-hover" />
        </span>
      ) : text ? (
        <span className="whitespace-pre-wrap break-words text-fg">{text}</span>
      ) : (
        <span className="text-fg-subtle">
          {person ? "The message was not captured." : "The reply was not captured."}
        </span>
      )}
      <span className="self-end text-xs tabular-nums text-fg-subtle">{clockTime(at)}</span>
    </>
  );
  if (!onClick) {
    return (
      <div data-chat-bubble={side} className={className}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-chat-bubble={side}
      aria-pressed={selected}
      onClick={onClick}
      className={className}
    >
      {body}
    </button>
  );
}

function WorkLineButton({
  turn,
  selected,
  onClick,
}: {
  turn: ChatTurn;
  selected: boolean;
  onClick: () => void;
}) {
  const { work } = turn;
  const toCheck = work.problems > 0;
  return (
    <button
      type="button"
      data-work-line={turn.turnIndex}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 self-start rounded-md border px-2 py-1 text-ui text-fg-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus",
        selected ? "border-line-active bg-hover text-fg" : "border-transparent",
      )}
    >
      <Wrench aria-hidden className="size-3.5" />
      <span className="tabular-nums">{workSummary(turn)}</span>
      {toCheck ? (
        <span className="inline-flex items-center gap-1 text-warning">
          <span aria-hidden>·</span>
          <TriangleAlert aria-hidden className="size-3.5" />
          {work.problems} to check
        </span>
      ) : null}
    </button>
  );
}

function DaySeparator({ at }: { at: string }) {
  return (
    <div className="self-center rounded-md bg-raised px-2 py-0.5 text-xs text-fg-subtle">
      {new Date(at).toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        timeZone: "UTC",
      })}
    </div>
  );
}

/** The work line without its problem count, which shows with its own icon. */
function workSummary({ work }: ChatTurn): string {
  return work.problems > 0 ? work.label.split(" · ").slice(0, -1).join(" · ") : work.label;
}
