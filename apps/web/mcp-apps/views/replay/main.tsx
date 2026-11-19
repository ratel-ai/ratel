"use client";

import { Button, IconButton } from "@ratel/design-system/button";
import { Callout } from "@ratel/design-system/states";
import { Maximize2, Minimize2 } from "lucide-react";
/**
 * Session replay: the console's own (components/session-chat: SessionChatView
 * with its SessionTrack, playback and StepInspector), from the same SessionChat
 * model as /sessions/[sessionId]. get_session, get_run_summary and
 * get_trace_conversation carry it in their result's `view`; a run opens on its
 * own turn. The inspector reads a step's stored text with tools/call
 * (get_session_step_content) instead of the console's server action. Opening a
 * step or a turn tells the model what the user is looking at.
 */
import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { SessionChatView } from "@/components/console/session-chat/SessionChatView";
import {
  type StepContentLoader,
  StepContentLoaderContext,
} from "@/components/console/session-chat/step-content";
import { sessionPageTitle } from "@/lib/synthesis/traces/v2/run-noun";
import type { StepContent } from "@/lib/views/session-chat/inspect-load";
import { parseChatPeek } from "@/lib/views/session-chat/peek";
import { useRatelView } from "../../shell/bridge";
import { consoleUrl, openExternal } from "../../shell/links";
import { mountView } from "../../shell/mount";
// The same module the console components get for next/navigation (the build aliases it).
import { useSearchParams } from "../../shell/shims/next-navigation";
import type { ToolSuccess } from "../../shell/state";
import { ViewFrame } from "../../shell/view-frame";
import view from "./bindings";
import { initialPeek, peekContext, readSessionChatView, type SessionChatViewData } from "./session";

/** Wide enough for the console's own layout, the panel beside the chat (SessionChatView's "push"). */
const WIDE = "(min-width: 64rem)";

function useWide(): boolean {
  const [wide, setWide] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(WIDE).matches === true,
  );
  useEffect(() => {
    const query = window.matchMedia?.(WIDE);
    if (!query) return;
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}

/** Opening steps one after another sends the model one update, once the user settles. */
const CONTEXT_DEBOUNCE_MS = 300;

function Replay({ result }: { result: ToolSuccess }) {
  const ratel = useRatelView();
  const data = useMemo(() => readSessionChatView(result), [result]);
  if (!data) {
    const href = (result.data as { href?: unknown } | null)?.href;
    return (
      <Callout tone="info" title="No session to replay">
        This result came without a session: the run is not part of a recorded one, or this app did
        not get it from Ratel. Open it in Ratel, or reconnect Ratel here and ask again.{" "}
        {typeof href === "string" ? (
          <Button variant="ghost" size="sm" onClick={() => ratel.openInConsole(href)}>
            Open in Ratel
          </Button>
        ) : null}
      </Callout>
    );
  }
  return <SessionReplay data={data} />;
}

function SessionReplay({ data }: { data: SessionChatViewData }) {
  const ratel = useRatelView();
  const { chat, projectId } = data;
  const fullscreen = ratel.displayMode === "fullscreen";
  // Inline the frame is narrow: the step panel slides over the chat. A wide fullscreen keeps the console's layout.
  const wide = useWide();
  const canFullscreen = ratel.displayModes.includes("fullscreen");
  const toCheck = chat.problems.length;

  // A run's view opens on its own turn, once.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const peek = initialPeek(data);
    if (peek) window.history.replaceState(null, "", `?peek=${encodeURIComponent(peek)}`);
  }, [data]);

  // The panel the user opened (?peek=, the view's in-memory location) is what the model hears about.
  const peekId = useSearchParams().get("peek");
  const { setContext } = ratel;
  useEffect(() => {
    const peek = parseChatPeek(peekId);
    const context = peek ? peekContext(chat, peek) : null;
    if (!context) return;
    const timer = setTimeout(
      () => void setContext(context.text, context.structured),
      CONTEXT_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [peekId, chat, setContext]);

  const { callTool } = ratel;
  const loadStepContent = useMemo<StepContentLoader>(
    () => async (project, request) => {
      const read = await callTool<{ content: StepContent | null }>("get_session_step_content", {
        projectId: project,
        eventIds: request.eventIds,
        ...(request.searchEventId ? { searchEventId: request.searchEventId } : {}),
      });
      return read.ok
        ? { ok: true, content: read.value.data.content }
        : { ok: false, error: read.error.message };
    },
    [callTool],
  );

  // A plain link to the console (the "turn it on in Settings" line) opens through the host, never in the frame.
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest("a[href]");
    const href = anchor?.getAttribute("href") ?? "";
    if (!/^https?:/.test(href) || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    openExternal(href);
  };

  return (
    <div className="flex flex-col gap-4" onClickCapture={onClickCapture}>
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold text-fg">
            {sessionPageTitle(
              chat.sessionId,
              chat.turns.map((turn) => turn.ask),
            )}
          </h1>
          <p className="truncate text-ui text-fg-muted">Session {chat.sessionId}</p>
        </div>
        <span className="self-center text-ui text-fg-muted tabular-nums">
          {toCheck > 0 ? `${toCheck} to check` : "Nothing to check"}
        </span>
        {canFullscreen ? (
          <IconButton
            label={fullscreen ? "Back to the chat" : "Fullscreen"}
            size="icon-sm"
            icon={
              fullscreen ? (
                <Minimize2 aria-hidden strokeWidth={1.5} />
              ) : (
                <Maximize2 aria-hidden strokeWidth={1.5} />
              )
            }
            onClick={() => void ratel.requestDisplayMode(fullscreen ? "inline" : "fullscreen")}
          />
        ) : null}
        {data.sessionHref ? (
          <Button variant="ghost" size="sm" onClick={() => ratel.openInConsole(data.sessionHref)}>
            Open in Ratel
          </Button>
        ) : null}
      </header>
      <StepContentLoaderContext.Provider value={loadStepContent}>
        <SessionChatView
          projectId={projectId}
          chat={chat}
          settingsHref={consoleUrl(data.settingsHref)}
          syncUrl={false}
          panelMode={fullscreen && wide ? "push" : "overlay"}
          // The console sizes it to the page; a frame sized to its content needs a height of its own, within the host's cap.
          className={
            fullscreen
              ? "h-[calc(var(--host-height,100vh)-8rem)] min-h-0"
              : "h-[min(36rem,calc(var(--host-max-height,100rem)-7rem))] min-h-[24rem]"
          }
        />
      </StepContentLoaderContext.Provider>
    </div>
  );
}

mountView(
  { name: "replay", bindings: view.bindings },
  <ViewFrame>{(result) => <Replay result={result} />}</ViewFrame>,
);
