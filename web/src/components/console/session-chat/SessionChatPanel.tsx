"use client";

import { IconButton } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { ChartGantt, Check, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { memo, type ReactNode } from "react";
import { PanelBoundary } from "@/components/console/session-replay/PanelBoundary";
import {
  type ChatTurn,
  formatDuration,
  formatStepTime,
  type SessionChat,
} from "@/lib/views/session-chat/model";
import type { StepContentSource } from "@/lib/views/session-chat/panel-client";
import { type ChatPeek, chatPeekId, sessionTraceHref } from "@/lib/views/session-chat/peek";
import { clockTime, segmentTime, stepWords } from "./format";
import type { ChatWhatIf, InspectorActions } from "./SessionChatView";
import { StepInspector } from "./StepInspector";

/**
 * The side panel of the session chat (RC-282, A2, A8): a message in full, a
 * work line step by step with where its time went, or one step (RC-284's
 * inspector). It sits beside
 * the chat and pushes it aside rather than covering it (DESIGN.md's Panel is a
 * modal overlay, so this is the same frame inline).
 */

export interface SessionChatPanelProps {
  projectId: string;
  chat: SessionChat;
  peek: ChatPeek;
  /** The inspector follows the playhead from call to call. */
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
  /** What if… for a model call; absent, the inspector has none. */
  whatIf?: ChatWhatIf;
  /** Where the inspector reads a step's content; absent, from the trace tables. */
  source?: StepContentSource;
  /** Actions under a step in the inspector; absent, the inspector has none. */
  inspectorActions?: InspectorActions;
  /** "Open full trace" on a work line; off for a chat with no trace. */
  traceLinks?: boolean;
  onOpen: (peek: ChatPeek) => void;
  onClose: () => void;
  /** Its width where it overlays the chat (SessionChatView panelMode "overlay"); 26rem beside it. */
  className?: string;
}

/**
 * Memo'd: the chat view re-renders on every move of the playhead, the panel
 * only when what it shows changes (RTL-368). Its body sits in an error
 * boundary, so a step that fails to render leaves the replay working.
 */
export const SessionChatPanel = memo(function SessionChatPanel(props: SessionChatPanelProps) {
  const body = panelBody(props);
  return (
    <aside
      data-chat-panel={props.peek.kind}
      aria-label={body.title}
      className={cn(
        "flex w-[26rem] shrink-0 flex-col border-l border-line bg-raised",
        props.className,
      )}
    >
      <header className="flex min-h-12 shrink-0 items-center gap-1 border-b border-line py-2 pr-2 pl-4">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-fg">{body.title}</h2>
          {body.subtitle ? (
            <p className="truncate text-xs tabular-nums text-fg-subtle">{body.subtitle}</p>
          ) : null}
        </div>
        <IconButton
          label="Close"
          shortcut="Esc"
          size="icon-sm"
          icon={<X />}
          onClick={props.onClose}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        <PanelBoundary name="step inspector" resetKey={chatPeekId(props.peek)}>
          {body.content}
        </PanelBoundary>
      </div>
    </aside>
  );
});

function panelBody({
  projectId,
  chat,
  peek,
  follow,
  onFollowChange,
  whatIf,
  source,
  inspectorActions,
  traceLinks = true,
  onOpen,
}: SessionChatPanelProps): { title: string; subtitle?: string; content: ReactNode } {
  if (peek.kind === "step") {
    const segment = chat.segments.find((s) => s.stepIndex === peek.stepIndex);
    if (!segment)
      return {
        title: "Step not found",
        content: (
          <p className="text-ui text-fg-muted">This session has no step {peek.stepIndex}.</p>
        ),
      };
    const call = chat.calls.find((c) => c.stepIndex === segment.stepIndex);
    const at = `at ${formatStepTime(segment.trackStartMs)}`;
    return {
      title: call ? `Model call ${call.callNumber} of ${chat.calls.length}` : stepWords(segment),
      subtitle: call
        ? `${call.model ?? "Unknown model"} · turn ${segment.turnIndex} · ${at}`
        : `${segmentTime(segment)} · turn ${segment.turnIndex} · ${at}`,
      content: (
        <StepInspector
          projectId={projectId}
          chat={chat}
          segment={segment}
          follow={follow}
          onFollowChange={onFollowChange}
          whatIf={whatIf}
          source={source}
          actions={inspectorActions}
          onOpen={onOpen}
        />
      ),
    };
  }
  const turn = chat.turns.find((t) => t.turnIndex === peek.turnIndex);
  if (!turn)
    return {
      title: "Turn not found",
      content: <p className="text-ui text-fg-muted">This session has no turn {peek.turnIndex}.</p>,
    };
  if (peek.kind === "work") {
    const title =
      turn.work.problems > 0
        ? `${turn.work.label.split(" · ")[0]}, ${turn.work.problems} to check`
        : turn.work.label.split(" · ")[0]!;
    const subtitle = `${formatDuration(turn.work.tookMs)} · ${turn.inputTokens.toLocaleString("en-US")} tokens · $${turn.costUsd.toFixed(4)}`;
    return {
      title,
      subtitle,
      content: (
        <WorkBody
          projectId={projectId}
          chat={chat}
          turn={turn}
          traceLink={traceLinks}
          onOpen={onOpen}
        />
      ),
    };
  }
  const person = peek.kind === "ask";
  const text = person ? turn.ask : turn.reply;
  return {
    title: person ? "Their message" : "Reply",
    subtitle: `Turn ${turn.turnIndex} · ${clockTime(person ? turn.startedAt : turn.endedAt)} UTC`,
    content: chat.textOff ? (
      <p className="text-ui text-fg-muted">Message text is off for this project.</p>
    ) : (
      <p className="whitespace-pre-wrap break-words text-sm text-fg">
        {text ?? "This message was not captured."}
      </p>
    ),
  };
}

function WorkBody({
  projectId,
  chat,
  turn,
  traceLink,
  onOpen,
}: {
  projectId: string;
  chat: SessionChat;
  turn: ChatTurn;
  traceLink: boolean;
  onOpen: (peek: ChatPeek) => void;
}) {
  const steps = chat.segments.filter(
    (s) =>
      s.turnIndex === turn.turnIndex &&
      s.stepIndex !== null &&
      s.kind !== "ask" &&
      s.kind !== "wait",
  );
  return (
    <div className="flex flex-col gap-6">
      {traceLink ? (
        <Link
          href={sessionTraceHref(projectId, chat.sessionId, turn.turnIndex)}
          className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "self-start")}
          data-open-full-trace={turn.turnIndex}
        >
          <ChartGantt aria-hidden />
          Open full trace
        </Link>
      ) : null}
      <section>
        <h3 className="mb-2 text-ui font-medium text-fg">Step by step</h3>
        {steps.length === 0 ? (
          <p className="text-ui text-fg-muted">The agent answered without a step.</p>
        ) : (
          <ol className="flex flex-col">
            {steps.map((segment) => (
              <li key={segment.stepIndex} data-work-step={segment.stepIndex}>
                <button
                  type="button"
                  onClick={() => onOpen({ kind: "step", stepIndex: segment.stepIndex! })}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-ui outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
                >
                  {segment.problem ? (
                    <TriangleAlert aria-label="To check" className="size-3.5 text-warning" />
                  ) : (
                    <Check aria-hidden className="size-3.5 text-success" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-fg">{stepWords(segment)}</span>
                  <span className="tabular-nums text-fg-subtle">{segmentTime(segment)}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
      <TimeSplitSection turn={turn} />
    </div>
  );
}

const SPLIT_PARTS = [
  { key: "thinkingMs", label: "Thinking", className: "bg-fg-faint" },
  { key: "toolMs", label: "Tool calls", className: "bg-fg-muted" },
  { key: "searchMs", label: "Tool search", className: "bg-line-active" },
] as const;

function TimeSplitSection({ turn }: { turn: ChatTurn }) {
  const total = turn.split.thinkingMs + turn.split.toolMs + turn.split.searchMs;
  return (
    <section data-time-split>
      <h3 className="mb-2 text-ui font-medium text-fg">Where the time went</h3>
      {total === 0 ? (
        <p className="text-ui text-fg-muted">No step of this turn has a measured time.</p>
      ) : (
        <>
          <div className="mb-2 flex h-2 overflow-hidden rounded-full bg-hover">
            {SPLIT_PARTS.map((part) => (
              <span
                key={part.key}
                className={part.className}
                style={{ width: `${(turn.split[part.key] / total) * 100}%` }}
              />
            ))}
          </div>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-ui">
            {SPLIT_PARTS.map((part) => (
              <div key={part.key} className="contents">
                <dt className="flex items-center gap-1.5 text-fg-muted">
                  <span aria-hidden className={cn("size-2 rounded-sm", part.className)} />
                  {part.label}
                </dt>
                <dd className="text-right tabular-nums text-fg">
                  {formatStepTime(turn.split[part.key])} ·{" "}
                  {Math.round((turn.split[part.key] / total) * 100)}%
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </section>
  );
}
