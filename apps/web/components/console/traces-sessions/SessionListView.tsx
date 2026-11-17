"use client";

import { StatusDot } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import type { Column } from "@ratel/design-system/data-table";
import { Page, PageBody } from "@ratel/design-system/page-header";
import { Panel, usePeek } from "@ratel/design-system/panel";
import { Callout, EmptyState, Skeleton } from "@ratel/design-system/states";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { SessionChatTranscript } from "@/components/console/session-chat/SessionChatView";
import { RelativeTime, TruncatedText } from "@/components/console/traces/cells";
import { useTraceNavigation } from "@/components/console/traces/navigation";
import { TraceFilterBar } from "@/components/console/traces/TraceFilterBar";
import { TracesEmpty, type TracesEmptyKind } from "@/components/console/traces/TracesEmpty";
import { TracesHeader } from "@/components/console/traces/TracesHeader";
import { TracesListTable } from "@/components/console/traces/TracesListTable";
import type { TraceFilterFacets } from "@/lib/synthesis/traces/trace-filters";
import { rollupFilterQuery, withoutFilters } from "@/lib/synthesis/traces/v2/filters";
import { formatDuration, formatInteger, formatMoney } from "@/lib/synthesis/traces/v2/format";
import type {
  SessionListPage,
  SessionListRow,
  SessionStatus,
} from "@/lib/synthesis/traces/v2/sessions-list";
import {
  SESSIONS_FILTER_LABEL,
  SESSIONS_FILTER_PARAM,
  SESSIONS_FILTERS,
  type SessionsFilter,
  withSessionsFilter,
} from "@/lib/synthesis/traces-sessions/view";
import { fetchSessionPanelChat } from "@/lib/views/session-chat/panel-client";
import type { SessionPanelChatResult } from "@/lib/views/session-chat/panel-route";
import { sessionTraceHref } from "@/lib/views/session-chat/peek";
import { TabSummary } from "./TabSummary";

export const SESSION_STATUS_LABEL: Readonly<Record<SessionStatus, string>> = {
  active: "Active",
  failed: "Failed",
  completed: "Completed",
};
const SESSION_STATUS_TONE = { active: "info", failed: "danger", completed: "success" } as const;

/** Reads the next page; the sessions route unless a test stubs it. */
export type LoadSessionListPage = (
  projectId: string,
  filter: SessionsFilter,
  cursor: string,
  search: string,
) => Promise<SessionListPage>;
/** Reads one session's chat for the Panel; the server action unless a test stubs it. */
export type LoadSessionPanelChat = (
  projectId: string,
  sessionId: string,
) => Promise<SessionPanelChatResult>;

export interface SessionListViewProps {
  projectId: string;
  filter: SessionsFilter;
  rows: readonly SessionListRow[];
  nextCursor: string | null;
  /** The request's time, for relative times. */
  now: string;
  empty: TracesEmptyKind | "no-failed" | null;
  /** The property bar's values (RC-506); null hides the bar. */
  filterFacets?: TraceFilterFacets | null;
  loadPage?: LoadSessionListPage;
  loadChat?: LoadSessionPanelChat;
}

/**
 * Traces, Sessions tab (RC-503, decisions
 * sessions-first and session-status): the first tab. One row per session,
 * newest last update first, in the table layout Turns shares (ID first). A
 * row opens the whole session as chat in the Panel.
 */
export function SessionListView(props: SessionListViewProps) {
  const { projectId, filter, empty } = props;
  const { search, pending, go } = useTraceNavigation();
  return (
    <Page>
      <TracesHeader projectId={projectId} search={search} timeWindow={null} onSearchChange={go} />
      <PageBody wide className="gap-4">
        <TabSummary projectId={projectId} tab="sessions" />
        <div className="flex flex-wrap items-center gap-2" data-sessions-filters>
          <SegmentedControl
            label="Show sessions"
            value={filter}
            onValueChange={(next) => go((current) => withSessionsFilter(current, next))}
            options={SESSIONS_FILTERS.map((value) => ({
              value,
              label: <span data-filter={value}>{SESSIONS_FILTER_LABEL[value]}</span>,
            }))}
          />
          {props.filterFacets ? (
            <TraceFilterBar
              tab="rollup"
              searchable={false}
              search={search}
              pending={pending}
              facets={props.filterFacets}
              onSearchChange={go}
            />
          ) : null}
        </div>
        {empty === "no-failed" ? (
          <div className="rounded-lg border border-line" data-sessions-empty="no-failed">
            <EmptyState
              title="No failed sessions"
              description="No session had a turn that ended in an error."
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => go((current) => withSessionsFilter(current, "all"))}
                >
                  Show all sessions
                </Button>
              }
            />
          </div>
        ) : empty === "filtered" ? (
          <div className="rounded-lg border border-line" data-sessions-empty="filtered">
            <EmptyState
              title="No sessions match"
              description="No session has a turn that matches these filters."
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => go((current) => withoutFilters("rollup", current))}
                >
                  Clear filters
                </Button>
              }
            />
          </div>
        ) : empty ? (
          <div className="rounded-lg border border-line" data-sessions-empty={empty}>
            <TracesEmpty kind={empty} unit="runs" projectId={projectId} />
          </div>
        ) : (
          <SessionList
            // A new first page (another filter, or a refresh) starts the list again.
            key={`${filter}:${props.rows[0]?.id ?? ""}:${props.nextCursor ?? ""}`}
            {...props}
            search={search}
            pending={pending}
          />
        )}
      </PageBody>
    </Page>
  );
}

function SessionList({
  projectId,
  filter,
  rows: firstRows,
  nextCursor: firstCursor,
  now,
  pending,
  search,
  loadPage = fetchSessionListPage,
  loadChat = fetchSessionPanelChat,
}: SessionListViewProps & { pending: boolean; search: string }) {
  const peek = usePeek();
  const [rows, setRows] = useState<readonly SessionListRow[]>(firstRows);
  const [cursor, setCursor] = useState(firstCursor);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const loading = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(() => {
    if (!cursor || loading.current) return;
    loading.current = true;
    setState("loading");
    loadPage(projectId, filter, cursor, search)
      .then((page) => {
        const seen = new Set(rows.map((row) => row.id));
        setRows([...rows, ...page.items.filter((row) => !seen.has(row.id))]);
        setCursor(page.nextCursor);
        setState("idle");
      })
      .catch((error: unknown) => {
        console.error("session list next page failed", error);
        setState("failed");
      })
      .finally(() => {
        loading.current = false;
      });
  }, [cursor, filter, loadPage, projectId, rows, search]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !cursor || state === "failed" || typeof IntersectionObserver === "undefined")
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [cursor, loadMore, state]);

  return (
    <section
      aria-label="Sessions"
      className={cn("flex flex-col gap-3 transition-opacity duration-160", pending && "opacity-60")}
      aria-busy={pending || state === "loading" || undefined}
    >
      <SessionListTable
        rows={rows}
        now={now}
        openId={peek.id}
        onOpen={(row) => peek.open(row.id)}
      />
      <div
        ref={sentinel}
        className="flex min-h-10 items-center justify-center gap-3 text-ui text-fg-muted"
        data-sessions-footer
      >
        {cursor ? (
          state === "failed" ? (
            <>
              The next sessions did not load.
              <Button variant="secondary" size="sm" onClick={loadMore}>
                Try again
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={loadMore}
              disabled={state === "loading"}
              data-load-more
            >
              {state === "loading" ? "Loading…" : "Load more"}
            </Button>
          )
        ) : (
          <span data-sessions-end>
            {filter === "failed" ? "That is every failed session." : "That is every session."}
          </span>
        )}
      </div>
      <SessionListPanel
        projectId={projectId}
        rows={rows}
        openId={peek.id}
        loadChat={loadChat}
        onOpen={peek.open}
        onClose={peek.close}
      />
    </section>
  );
}

/** The Sessions columns of decision sessions-first, after the shared ID column. */
export function SessionListTable({
  rows,
  now,
  openId,
  onOpen,
}: {
  rows: readonly SessionListRow[];
  now: string;
  openId: string | null;
  onOpen: (row: SessionListRow) => void;
}) {
  const columns: Column<SessionListRow>[] = [
    {
      id: "status",
      header: "Status",
      width: "7.5rem",
      cell: (row) => (
        <StatusDot
          tone={SESSION_STATUS_TONE[row.status]}
          label={SESSION_STATUS_LABEL[row.status]}
        />
      ),
    },
    {
      id: "first",
      header: "First message",
      // The flexible column: it takes the room left and truncates inside it.
      className: "w-full max-w-0 min-w-48",
      cell: (row) => (
        <TruncatedText
          text={row.firstMessage ?? "Not captured"}
          className={row.firstMessage ? "text-fg" : "text-fg-subtle"}
        />
      ),
    },
    {
      id: "last",
      header: "Last turn",
      width: "16rem",
      className: "max-w-64",
      cell: (row) => (
        <TruncatedText
          text={row.lastTurn ?? "Not captured"}
          className={row.lastTurn ? "text-fg-muted" : "text-fg-subtle"}
        />
      ),
    },
    {
      id: "turns",
      header: "Turns",
      align: "right",
      width: "4.5rem",
      cell: (row) => formatInteger(row.turns),
    },
    {
      id: "duration",
      header: "Duration",
      align: "right",
      width: "6.5rem",
      className: "whitespace-nowrap",
      cell: (row) => formatDuration(row.durationMs),
    },
    {
      id: "started",
      header: "Started",
      width: "8.5rem",
      cell: (row) => <RelativeTime value={row.startedAt} now={now} />,
    },
    {
      id: "updated",
      header: "Last update",
      width: "8.5rem",
      cell: (row) => <RelativeTime value={row.lastActivityAt} now={now} />,
    },
    {
      id: "tokens",
      header: "Tokens",
      align: "right",
      width: "6.5rem",
      cell: (row) => formatInteger(row.tokens),
    },
    {
      id: "cost",
      header: "Cost",
      align: "right",
      width: "6rem",
      cell: (row) => formatMoney(row.costUsd),
    },
  ];
  return (
    <TracesListTable
      caption="Sessions"
      idOf={(row: SessionListRow) => row.id}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      onRowOpen={onOpen}
      selectedKey={openId}
    />
  );
}

/** The whole session as chat, beside the list, with the way to its replay and to each turn. */
export function SessionListPanel({
  projectId,
  rows,
  openId,
  loadChat,
  onOpen,
  onClose,
}: {
  projectId: string;
  rows: readonly SessionListRow[];
  openId: string | null;
  loadChat: LoadSessionPanelChat;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  // Keep showing the last row while the Panel animates closed.
  const [lastId, setLastId] = useState(openId);
  if (openId && openId !== lastId) setLastId(openId);
  const shownId = openId ?? lastId;
  const index = rows.findIndex((row) => row.id === shownId);
  const row = index >= 0 ? rows[index]! : null;
  const [results, setResults] = useState<ReadonlyMap<string, SessionPanelChatResult>>(
    () => new Map(),
  );
  const result = row ? results.get(row.id) : undefined;

  useEffect(() => {
    if (!openId || !row || result) return;
    let live = true;
    loadChat(projectId, row.id)
      .catch((error: unknown): SessionPanelChatResult => {
        console.error("session panel chat load failed", error);
        return { ok: false, error: "This session could not be loaded. Try again." };
      })
      .then((next) => {
        if (live) setResults((current) => new Map(current).set(row.id, next));
      });
    return () => {
      live = false;
    };
  }, [openId, row, result, projectId, loadChat]);

  const step = (direction: 1 | -1) => {
    const next = rows[index + direction];
    if (next) onOpen(next.id);
  };

  return (
    <Panel
      open={openId !== null && row !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={row ? (row.firstMessage ?? `Session ${row.id.slice(0, 8)}`) : "Session"}
      subtitle={
        row
          ? `${SESSION_STATUS_LABEL[row.status]} · ${formatInteger(row.turns)} ${row.turns === 1 ? "turn" : "turns"} · ${formatDuration(row.durationMs)}`
          : undefined
      }
      onPrevious={index > 0 ? () => step(-1) : undefined}
      onNext={index >= 0 && index < rows.length - 1 ? () => step(1) : undefined}
    >
      {row ? (
        <SessionListPanelBody
          projectId={projectId}
          row={row}
          result={result}
          onRetry={() =>
            setResults((current) => new Map([...current].filter(([id]) => id !== row.id)))
          }
        />
      ) : null}
    </Panel>
  );
}

/** The Panel's body; `result` is undefined while the chat loads. */
export function SessionListPanelBody({
  projectId,
  row,
  result,
  onRetry,
}: {
  projectId: string;
  row: SessionListRow;
  result: SessionPanelChatResult | undefined;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col gap-5" data-session-list-panel>
      <Link
        href={row.href}
        className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "self-start")}
        data-open-replay
      >
        Open session replay
        <ArrowRight aria-hidden />
      </Link>
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
      {result === undefined ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <span className="sr-only">Loading the conversation…</span>
          <Skeleton className="h-9 w-2/3 self-end rounded-lg" />
          <Skeleton className="h-14 w-3/4 rounded-lg" />
          <Skeleton className="h-9 w-1/2 self-end rounded-lg" />
        </div>
      ) : !result.ok ? (
        <Callout
          tone="danger"
          title={result.error}
          action={
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          }
        />
      ) : result.chat ? (
        <SessionChatTranscript
          chat={result.chat}
          turnHref={(turn) =>
            turn.traceId
              ? `/project/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(turn.traceId)}`
              : sessionTraceHref(projectId, row.id, turn.turnIndex)
          }
        />
      ) : (
        <p className="text-sm text-fg-muted">
          This session has no finished turn yet. The replay shows it when one ends.
        </p>
      )}
    </div>
  );
}

async function fetchSessionListPage(
  projectId: string,
  filter: SessionsFilter,
  cursor: string,
  search: string,
): Promise<SessionListPage> {
  // The next page reads the same property filters the first one did.
  const params = rollupFilterQuery(search);
  params.set(SESSIONS_FILTER_PARAM, filter);
  params.set("cursor", cursor);
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/traces/sessions?${params.toString()}`,
  );
  const body = (await response.json()) as { ok: boolean; data?: SessionListPage; message?: string };
  if (!response.ok || !body.ok || !body.data)
    throw new Error(body.message ?? `session list page read failed (${response.status})`);
  return body.data;
}
