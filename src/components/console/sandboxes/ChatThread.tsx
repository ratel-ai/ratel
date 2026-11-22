"use client";

import { Button } from "@ratel/design-system/button";
import { DotLoaderLazy } from "@ratel/design-system/dot-loader-lazy";
import { Textarea } from "@ratel/design-system/input";
import { ArrowUpRight, MessageSquarePlus, Send, Square } from "lucide-react";
import Link from "next/link";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import {
  type ChatTurn,
  chatTurn,
  inputSkeleton,
  type RunViewState,
  type ToolCallView,
} from "@/lib/views/sandboxes/playground-state";
import type { ManifestTool } from "@/lib/views/sandboxes/tools-state";
import { type ConfirmDecision, type SendOutcome, ToolCard } from "./ToolCard";
import { traceHref } from "./types";

export interface ChatThreadProps {
  projectId: string;
  /** `/api/projects/<id>/sandboxes`. */
  api: string;
  tools: readonly ManifestTool[];
  /** The finished turns of this chat, oldest first. */
  turns: readonly ChatTurn[];
  /** The turn in flight (or the last one, until the next message): its message and its run. */
  pending: { user: string; view: RunViewState } | null;
  sessionId: string | null;
  online: boolean;
  /** A run or a compare is in progress, so no new turn may start. */
  busy: boolean;
  cancelling: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
  onNewChat: () => void;
}

/**
 * The center of a chat sandbox (spec §9): the conversation and a composer. Each
 * message is one run in the chat's session; the reply streams in with its
 * tool calls as cards, and each reply links to its trace. A runner that goes
 * offline pauses the session until it comes back.
 */
export function ChatThread({
  projectId,
  api,
  tools,
  turns,
  pending,
  sessionId,
  online,
  busy,
  cancelling,
  onSend,
  onCancel,
  onNewChat,
}: ChatThreadProps) {
  const [draft, setDraft] = useState("");
  const end = useRef<HTMLDivElement | null>(null);
  const live =
    pending !== null && (pending.view.phase === "starting" || pending.view.phase === "live");
  const canSend = online && !busy && draft.trim() !== "";
  const empty = turns.length === 0 && pending === null;

  // Keep the newest text in sight as it streams.
  const lastText = pending?.view.text.length ?? 0;
  const lastTools = pending?.view.tools.length ?? 0;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [turns.length, lastText, lastTools]);

  function send() {
    if (!canSend) return;
    onSend(draft.trim());
    setDraft("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }

  const fakeSkeleton = (tool: string) => {
    const schema = tools.find((t) => t.name === tool)?.outputSchema;
    return schema ? inputSkeleton(schema) : {};
  };

  async function confirm(
    runId: string,
    callId: string,
    decision: ConfirmDecision,
    value?: unknown,
  ): Promise<SendOutcome> {
    const body = {
      callId,
      decision,
      ...(decision === "edit" ? { args: value } : {}),
      ...(decision === "fake" ? { result: value } : {}),
    };
    try {
      const res = await fetch(`${api}/runs/${encodeURIComponent(runId)}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 202) return "ok";
      return res.status === 409 ? "decided" : "failed";
    } catch {
      // Offline: nothing was sent, so the buttons come back.
      return "failed";
    }
  }

  async function pin(call: ToolCallView): Promise<boolean> {
    if (!sessionId) return false;
    try {
      const res = await fetch(`${api}/pins`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId,
          tool: call.tool,
          args: call.args,
          result: call.result ?? null,
          isError: call.isError === true,
        }),
      });
      return res.status === 201;
    } catch {
      // Offline: the card offers the pin again.
      return false;
    }
  }

  // One keyed list, so a card keeps its state (Pinned) when its turn stops being the pending one.
  const rows = [
    ...turns.map((turn) => ({ turn, live: false })),
    ...(pending ? [{ turn: chatTurn(pending.user, pending.view), live }] : []),
  ];

  const cardsFor = (calls: readonly ToolCallView[], runId: string | null, running: boolean) =>
    calls.map((call) => (
      <ToolCard
        key={call.callId}
        call={call}
        fakeSkeleton={fakeSkeleton(call.tool)}
        onConfirm={
          running && runId
            ? (decision, value) => confirm(runId, call.callId, decision, value)
            : undefined
        }
        onPin={sessionId ? () => pin(call) : undefined}
      />
    ));

  return (
    <section className="flex min-w-0 flex-col gap-4" aria-label="Chat">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-fg">Chat</h2>
        <Button variant="ghost" size="sm" onClick={onNewChat} disabled={empty || live}>
          <MessageSquarePlus className="size-3.5" aria-hidden />
          New chat
        </Button>
      </div>

      <div
        className="flex max-h-[min(70vh,48rem)] min-h-64 flex-col gap-5 overflow-y-auto rounded-lg border border-line p-4"
        aria-live="polite"
        aria-busy={live}
      >
        {empty ? (
          <p className="m-auto text-center text-ui text-fg-muted">
            Send a message to start a session. Each message is one run.
          </p>
        ) : null}
        {rows.map((row, index) => (
          <TurnView
            key={row.turn.runId ?? `turn-${index}`}
            projectId={projectId}
            turn={row.turn}
            live={row.live}
          >
            {cardsFor(row.turn.tools, row.turn.runId, row.live)}
          </TurnView>
        ))}
        <div ref={end} />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="sandbox-chat-composer" className="sr-only">
          Message
        </label>
        <Textarea
          id="sandbox-chat-composer"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={!online}
          placeholder={online ? "Write a message" : "The session is paused"}
          className="min-h-20"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            onClick={send}
            disabled={!canSend}
            loading={pending?.view.phase === "starting"}
          >
            <Send className="size-3.5" aria-hidden />
            {pending?.view.phase === "starting" ? "Sending…" : "Send message"}
          </Button>
          {pending?.view.phase === "live" ? (
            <Button onClick={onCancel} loading={cancelling}>
              <Square className="size-3.5" aria-hidden />
              {cancelling ? "Canceling…" : "Cancel run"}
            </Button>
          ) : null}
          {online ? (
            <span className="text-xs text-fg-subtle">Enter sends. Shift+Enter adds a line.</span>
          ) : (
            <span className="text-ui text-warning" role="status">
              Runner offline: the session is paused. Start{" "}
              <code className="font-mono">ratel sandbox dev</code> to resume.
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

function TurnView({
  projectId,
  turn,
  live,
  children,
}: {
  projectId: string;
  turn: ChatTurn;
  live: boolean;
  children: ReactNode;
}) {
  const hasTools = turn.tools.length > 0;
  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-[85%] self-end rounded-lg bg-selected px-3 py-2 text-ui whitespace-pre-wrap break-words text-fg">
        {turn.user}
      </p>
      <div className="flex max-w-[92%] flex-col gap-2 self-start">
        {hasTools ? <div className="flex flex-col gap-2">{children}</div> : null}
        {turn.assistant ? (
          <p className="text-ui leading-6 whitespace-pre-wrap break-words text-fg">
            {turn.assistant}
          </p>
        ) : null}
        {live && !turn.assistant ? (
          <DotLoaderLazy label={hasTools ? "Working" : "Thinking"} size="sm" />
        ) : null}
        {!live && turn.error ? (
          <p className="rounded-md bg-danger-subtle px-3 py-2 text-ui text-danger">
            This turn failed. {turn.error}
          </p>
        ) : null}
        {!live && turn.status === "ok" && !turn.assistant && !hasTools ? (
          <p className="text-ui text-fg-subtle">No reply text.</p>
        ) : null}
        <TurnFooter projectId={projectId} turn={turn} live={live} />
      </div>
    </div>
  );
}

function TurnFooter({
  projectId,
  turn,
  live,
}: {
  projectId: string;
  turn: ChatTurn;
  live: boolean;
}) {
  if (live || !turn.traceId) return null;
  return (
    <div className="flex items-center gap-3">
      <Link
        href={traceHref(projectId, turn.traceId)}
        className="inline-flex items-center gap-1 rounded-sm text-xs text-fg-muted underline-offset-2 outline-none hover:text-fg hover:underline focus-visible:ring-2 focus-visible:ring-focus"
      >
        View trace
        <ArrowUpRight className="size-3.5" aria-hidden />
      </Link>
    </div>
  );
}
