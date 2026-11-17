"use client";

import { StatusDot } from "@ratel/design-system/badge";
import { Button, IconButton } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@ratel/design-system/menu";
import { Page, PageBody } from "@ratel/design-system/page-header";
import { usePeek } from "@ratel/design-system/panel";
import { EmptyState } from "@ratel/design-system/states";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { Check, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTraceNavigation } from "@/components/console/traces/navigation";
import type { LoadRunSummary } from "@/components/console/traces/RunPanel";
import { fetchRunSummary } from "@/components/console/traces/run-summary-client";
import { TracesEmpty, type TracesEmptyKind } from "@/components/console/traces/TracesEmpty";
import { TracesHeader } from "@/components/console/traces/TracesHeader";
import { useRunNoun, useTraceViewsV3 } from "@/components/console/traces/views-v3-context";
import type { SessionRow, SessionsPage } from "@/lib/synthesis/traces-sessions/sessions";
import {
  appendSessionsPage,
  SESSION_COLUMN_LABEL,
  SESSION_COLUMNS,
  SESSIONS_FILTER_LABEL,
  SESSIONS_FILTER_PARAM,
  SESSIONS_FILTERS,
  type SessionsFilter,
  sessionColumnsFrom,
  withSessionColumns,
  withSessionsFilter,
} from "@/lib/synthesis/traces-sessions/view";
import { SessionPanel } from "./SessionPanel";
import { SessionsTable } from "./SessionsTable";
import { TabSummary } from "./TabSummary";

/** A running search experiment (Ratel vs own search): its rows carry a small label. */
export interface RunningSearchExperiment {
  name: string;
  href: string;
}

/** Reads the next page; the sessions route unless a test stubs it. */
export type LoadSessionsPage = (
  projectId: string,
  filter: SessionsFilter,
  cursor: string,
) => Promise<SessionsPage>;

export interface SessionsViewProps {
  projectId: string;
  filter: SessionsFilter;
  rows: readonly SessionRow[];
  nextCursor: string | null;
  empty: TracesEmptyKind | "no-failed" | null;
  experiment: RunningSearchExperiment | null;
  loadPage?: LoadSessionsPage;
  loadSummary?: LoadRunSummary;
}

/**
 * Traces, Sessions tab (`cloud-traces-sessions`, RC-313): "What did people
 * ask, and which sessions failed?" One row per session (or run with no
 * session), newest first, by day. The next page loads when the person reaches
 * the end, or with Load more. A row opens a short chat preview in a Panel.
 */
export function SessionsView(props: SessionsViewProps) {
  const { projectId, filter, empty, experiment } = props;
  const { search, pending, go, replaceView } = useTraceNavigation();
  const columns = sessionColumnsFrom(search);
  const noun = useRunNoun();
  // RC-472: with the redesign cost always shows, so it is no toggle.
  const toggles = useTraceViewsV3()
    ? SESSION_COLUMNS.filter((column) => column !== "cost")
    : SESSION_COLUMNS;
  const toggleColumn = (column: (typeof SESSION_COLUMNS)[number]) =>
    replaceView(
      withSessionColumns(
        search,
        columns.includes(column) ? columns.filter((item) => item !== column) : [...columns, column],
      ),
    );

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
          <Menu>
            <MenuTrigger
              render={<IconButton label="Columns" size="icon-sm" icon={<SlidersHorizontal />} />}
            />
            <MenuContent align="start">
              {toggles.map((column) => (
                <MenuItem
                  key={column}
                  icon={
                    columns.includes(column) ? <Check /> : <span aria-hidden className="size-4" />
                  }
                  onClick={() => toggleColumn(column)}
                >
                  Show {SESSION_COLUMN_LABEL[column].toLowerCase()}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
          {experiment ? (
            <Link
              href={experiment.href}
              title={`Experiment ${experiment.name} is running.`}
              className="ml-auto text-xs text-fg-muted hover:text-fg"
              data-experiment-label
            >
              <StatusDot tone="info" label="Experiment running" className="text-xs" />
            </Link>
          ) : null}
        </div>

        {empty === "no-failed" ? (
          <div className="rounded-lg border border-line" data-sessions-empty="no-failed">
            <EmptyState
              title="No failed sessions"
              description={`No session or ${noun.lower} ended in an error or had a failed tool call.`}
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
        ) : empty ? (
          <div className="rounded-lg border border-line" data-sessions-empty={empty}>
            <TracesEmpty kind={empty} unit="runs" projectId={projectId} />
          </div>
        ) : (
          <SessionsList
            // A new first page (another filter, or a refresh) starts the list again.
            key={`${filter}:${props.rows[0] ? `${props.rows[0].kind}:${props.rows[0].id}` : ""}:${props.nextCursor ?? ""}`}
            {...props}
            columns={columns}
            pending={pending}
          />
        )}
      </PageBody>
    </Page>
  );
}

function SessionsList({
  projectId,
  filter,
  rows: firstRows,
  nextCursor: firstCursor,
  experiment,
  columns,
  pending,
  loadPage = fetchSessionsPage,
  loadSummary = fetchRunSummary,
}: SessionsViewProps & { columns: ReturnType<typeof sessionColumnsFrom>; pending: boolean }) {
  const peek = usePeek();
  const [rows, setRows] = useState<readonly SessionRow[]>(firstRows);
  const [cursor, setCursor] = useState(firstCursor);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const loading = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(() => {
    if (!cursor || loading.current) return;
    loading.current = true;
    setState("loading");
    loadPage(projectId, filter, cursor)
      .then((page) => {
        const next = appendSessionsPage(rows, page);
        setRows(next.rows);
        setCursor(next.nextCursor);
        setState("idle");
      })
      .catch((error: unknown) => {
        console.error("sessions next page failed", error);
        setState("failed");
      })
      .finally(() => {
        loading.current = false;
      });
  }, [cursor, filter, loadPage, projectId, rows]);

  // The next page loads as the end of the list comes into view; a failed read waits for Try again.
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
      <SessionsTable
        rows={rows}
        columns={columns}
        experiment={experiment}
        openKey={peek.id}
        onOpen={(key) => peek.open(key)}
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
            // Keyboard and screen-reader users reach the next page without scrolling.
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
      <SessionPanel
        projectId={projectId}
        rows={rows}
        openKey={peek.id}
        loadSummary={loadSummary}
        onOpen={peek.open}
        onClose={peek.close}
      />
    </section>
  );
}

async function fetchSessionsPage(
  projectId: string,
  filter: SessionsFilter,
  cursor: string,
): Promise<SessionsPage> {
  const params = new URLSearchParams({ [SESSIONS_FILTER_PARAM]: filter, cursor });
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/traces/sessions?${params.toString()}`,
  );
  const body = (await response.json()) as { ok: boolean; data?: SessionsPage; message?: string };
  if (!response.ok || !body.ok || !body.data)
    throw new Error(body.message ?? `sessions page read failed (${response.status})`);
  return body.data;
}
