"use client";

import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { usePeek } from "@ratel/design-system/panel";
import { isTypingTarget } from "@ratel/design-system/peek";
import { Callout } from "@ratel/design-system/states";
import { Check, Ellipsis, ListChecks, TriangleAlert, Wrench } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createUrlWriter, withQueryUpdates } from "@/lib/synthesis/traces/v2/url-writer";
import {
  type ChatTurn,
  formatStepTime,
  type SessionChat,
  type TrackSegment,
} from "@/lib/views/session-chat/model";
import { type ChatPeek, chatPeekId, parseChatPeek } from "@/lib/views/session-chat/peek";
import {
  adjacentStop,
  chatStateAt,
  keyAction,
  parsePlayhead,
  parseZoom,
  type TurnPhase,
  type Zoom,
} from "@/lib/views/session-chat/playback";
import { clockTime, segmentTime, stepWords } from "./format";
import { SessionChatPanel } from "./SessionChatPanel";
import { SessionTrack, type Speed } from "./SessionTrack";

/**
 * The session as a chat (RC-282, RC-283; A1–A5, A9): the person's messages on
 * the right, the agent's replies on the left, and the agent's work between
 * them as one line, over a time-scaled track. The chat shows the session at
 * the playhead: a turn in progress lists its steps so far with a running
 * timer, and collapses into its work line when it ends ("Show actions" opens
 * them again). A click opens the side panel, which pushes the chat aside.
 * The panel is `?peek=`, the playhead `?t=` and the zoom `?zoom=`; Esc closes
 * the panel, ←/→ move a step, Space plays.
 */

export interface SessionChatViewProps {
  projectId: string;
  chat: SessionChat;
  /** Project settings, where an admin turns message text on. */
  settingsHref: string;
}

export function SessionChatView({ projectId, chat, settingsHref }: SessionChatViewProps) {
  const { id, open: openPeek, close } = usePeek();
  const peek = parseChatPeek(id);
  const open = (next: ChatPeek) => openPeek(chatPeekId(next));
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const total = chat.trackTotalMs;
  const [t, setT] = useState(() => parsePlayhead(searchParams.get("t"), total));
  const [zoom, setZoom] = useState<Zoom>(() => parseZoom(searchParams.get("zoom")));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [showActions, setShowActions] = useState(false);
  const [follow, setFollow] = useState(false);
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
    if (firstWrite.current) {
      firstWrite.current = false;
      return;
    }
    writer.set({
      t: t >= total ? null : String(Math.round(t)),
      zoom: zoom === 1 ? null : String(zoom),
    });
  }, [t, zoom, total, writer]);
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
    follow && peek?.kind === "step" && chat.calls.some((c) => c.stepIndex === peek.stepIndex)
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
    <div className="flex h-[min(52rem,calc(100dvh-10rem))] min-h-[32rem] overflow-hidden rounded-xl border border-line bg-app">
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
        />
      </div>
      {peek ? (
        <SessionChatPanel
          projectId={projectId}
          chat={chat}
          peek={peek}
          follow={follow}
          onFollowChange={setFollow}
          onOpen={open}
          onClose={close}
        />
      ) : null}
    </div>
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
  selected,
  onClick,
}: {
  side: "person" | "agent";
  text: string | null;
  textOff: boolean;
  at: string;
  selected: boolean;
  onClick: () => void;
}) {
  const person = side === "person";
  return (
    <button
      type="button"
      data-chat-bubble={side}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "flex max-w-[80%] flex-col gap-1 rounded-xl border px-3.5 py-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus",
        person ? "self-end border-line-strong bg-selected" : "self-start border-line bg-raised",
        selected && "border-line-active",
      )}
    >
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
