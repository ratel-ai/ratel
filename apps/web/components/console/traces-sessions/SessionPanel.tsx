"use client";

import { Badge, StatusDot } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { Panel } from "@ratel/design-system/panel";
import { Callout, Skeleton } from "@ratel/design-system/states";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { LoadRunSummary } from "@/components/console/traces/RunPanel";
import {
  formatClock,
  formatDuration,
  formatInteger,
  formatMoney,
} from "@/lib/synthesis/traces/v2/format";
import { TURN_NOUN } from "@/lib/synthesis/traces/v2/run-noun";
import { SUMMARY_READ_DELAY_MS } from "@/lib/synthesis/traces/v2/run-panel";
import type { RunSummaryResult } from "@/lib/synthesis/traces/v2/run-summary-route";
import type { SessionRow } from "@/lib/synthesis/traces-sessions/sessions";
import { sessionRowKey, sessionTitle } from "@/lib/synthesis/traces-sessions/view";

const LOAD_FAILED: RunSummaryResult = {
  ok: false,
  message: "Couldn't load this conversation. Try again in a moment.",
};
/** Characters of a message the preview keeps; the replay has the rest. */
const PREVIEW_CHARS = 280;

/**
 * One session without leaving the list: a short chat preview (its first ask
 * and answer, read from its first run when the Panel rests on it), whether it
 * failed, its tools, tokens and cost, and "Open session replay" (a run with no
 * session opens its full trace).
 */
export function SessionPanel({
  projectId,
  rows,
  openKey,
  loadSummary,
  onOpen,
  onClose,
}: {
  projectId: string;
  rows: readonly SessionRow[];
  openKey: string | null;
  loadSummary: LoadRunSummary;
  onOpen: (key: string) => void;
  onClose: () => void;
}) {
  // Keep showing the last row while the Panel animates closed.
  const [lastKey, setLastKey] = useState(openKey);
  if (openKey && openKey !== lastKey) setLastKey(openKey);
  const shownKey = openKey ?? lastKey;
  const index = rows.findIndex((row) => sessionRowKey(row) === shownKey);
  const row = index >= 0 ? rows[index] : null;
  const firstRun = row?.traceIds[0] ?? null;
  const [results, setResults] = useState<ReadonlyMap<string, RunSummaryResult>>(() => new Map());
  const result = firstRun ? results.get(firstRun) : undefined;

  useEffect(() => {
    if (!openKey || !firstRun || result) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      loadSummary(projectId, firstRun, controller.signal)
        .catch((): RunSummaryResult => LOAD_FAILED)
        .then((next) => {
          if (!controller.signal.aborted)
            setResults((current) => new Map(current).set(firstRun, next));
        });
    }, SUMMARY_READ_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [openKey, firstRun, result, projectId, loadSummary]);

  const step = (direction: 1 | -1) => {
    const next = rows[index + direction];
    if (next) onOpen(sessionRowKey(next));
  };

  return (
    <Panel
      open={openKey !== null && row !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={row ? sessionTitle(row).text : "Session"}
      subtitle={
        row ? `${formatClock(row.startedAt)} · ${formatDuration(row.durationMs)}` : undefined
      }
      onPrevious={index > 0 ? () => step(-1) : undefined}
      onNext={index >= 0 && index < rows.length - 1 ? () => step(1) : undefined}
    >
      {row ? (
        <SessionPanelBody
          row={row}
          result={firstRun ? result : null}
          onRetry={
            firstRun
              ? () =>
                  setResults((current) => new Map([...current].filter(([id]) => id !== firstRun)))
              : null
          }
        />
      ) : null}
    </Panel>
  );
}

/** The Panel's body; `result` is undefined while the preview loads and null when there is no run to read. */
export function SessionPanelBody({
  row,
  result,
  onRetry,
}: {
  row: SessionRow;
  result: RunSummaryResult | null | undefined;
  onRetry: (() => void) | null;
}) {
  const noun = TURN_NOUN;
  return (
    <div className="flex flex-col gap-5" data-session-panel={row.kind}>
      {result === undefined ? (
        <ChatSkeleton />
      ) : result === null ? (
        <p className="text-sm text-fg-muted">
          This session has no {noun.lower} to preview. The replay still shows each step.
        </p>
      ) : result.ok ? (
        <ChatPreview
          ask={result.summary.ask ?? row.ask}
          answer={result.summary.answer}
          captured={result.summary.contentCaptured || row.ask !== null}
        />
      ) : (
        <Callout
          tone="danger"
          title={result.message}
          action={
            onRetry ? (
              <Button size="sm" onClick={onRetry}>
                Try again
              </Button>
            ) : null
          }
        />
      )}

      <Link
        href={row.href}
        className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "self-start")}
        data-open-replay
      >
        {row.kind === "session" ? "Open session replay" : "Open full trace"}
        <ArrowRight aria-hidden />
      </Link>

      {row.failed ? (
        <StatusDot
          tone="danger"
          label={row.kind === "session" ? "This session failed" : `This ${noun.lower} failed`}
        />
      ) : null}

      <dl className="grid grid-cols-3 gap-4">
        <div>
          <dt className="text-xs text-fg-subtle">Turns</dt>
          <dd className="text-sm text-fg tabular-nums">{formatInteger(row.turns)}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-subtle">Tokens</dt>
          <dd className="text-sm text-fg tabular-nums">{formatInteger(row.tokens)}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-subtle">Cost</dt>
          <dd className="text-sm text-fg tabular-nums">{formatMoney(row.costUsd)}</dd>
        </div>
      </dl>

      <section aria-label="Tools" className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-fg">Tools</h3>
        {row.tools.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {row.tools.map((tool) => (
              <Badge key={tool}>
                <code className="font-mono">{tool}</code>
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-fg-muted">No tool was called.</p>
        )}
      </section>
    </div>
  );
}

function ChatPreview({
  ask,
  answer,
  captured,
}: {
  ask: string | null;
  answer: string | null;
  captured: boolean;
}) {
  if (!captured || (!ask && !answer)) {
    return (
      <p className="text-sm text-fg-muted">
        Message text isn&apos;t captured for this session. The replay still shows each step.
      </p>
    );
  }
  return (
    <ol aria-label="Chat preview" className="flex flex-col gap-2">
      {ask ? (
        <li
          className="max-w-[85%] self-end rounded-lg bg-raised px-3 py-2 text-sm whitespace-pre-wrap text-fg"
          data-role="user"
        >
          {clip(ask)}
        </li>
      ) : null}
      {answer ? (
        <li
          className="max-w-[85%] self-start rounded-lg border border-line px-3 py-2 text-sm whitespace-pre-wrap text-fg"
          data-role="assistant"
        >
          {clip(answer)}
        </li>
      ) : null}
    </ol>
  );
}

function ChatSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <span className="sr-only">Loading the conversation…</span>
      <Skeleton className="h-9 w-2/3 self-end rounded-lg" />
      <Skeleton className="h-14 w-3/4 rounded-lg" />
    </div>
  );
}

function clip(text: string): string {
  return text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS - 1).trimEnd()}…`;
}
