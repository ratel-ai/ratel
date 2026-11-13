"use client";

import { StatusDot } from "@ratel/design-system/badge";
import { cn } from "@ratel/design-system/cn";
import { type Column, DataTable, type SortDirection } from "@ratel/design-system/data-table";
import { Page, PageBody } from "@ratel/design-system/page-header";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { useRouter } from "next/navigation";
import type { RangePreset } from "@/lib/synthesis/dashboard";
import type {
  OperationAggregate,
  OperationGroupBy,
  TraceFacets,
} from "@/lib/synthesis/traces/queries";
import {
  withCursor,
  withoutCursor,
  withoutFilters,
  withRangePreset,
  withSort,
} from "@/lib/synthesis/traces/v2/filters";
import {
  formatDuration,
  formatInteger,
  formatMoney,
  formatPercent,
  shortId,
} from "@/lib/synthesis/traces/v2/format";
import { STEP_KIND_LABEL, stepKind, stepTitle } from "@/lib/synthesis/traces/v2/span-kind";
import type { SpanSummaryView } from "@/lib/synthesis/traces/view";
import { RelativeTime, TruncatedText } from "./cells";
import { KIND_DOT } from "./kind";
import { useTraceNavigation } from "./navigation";
import { ListFooter } from "./RunsTable";
import { TraceFilterBar } from "./TraceFilterBar";
import { TracesEmpty, type TracesEmptyKind } from "./TracesEmpty";
import { type TimeWindow, TracesHeader } from "./TracesHeader";

export type SpanSort = "started" | "duration" | "tokens" | "cost";
export type OperationSortId = "key" | "count" | "errorRate" | "p50" | "p95" | "cost" | "tokens";

export interface SpansViewProps {
  projectId: string;
  now: string;
  timeWindow: TimeWindow;
  facets: Pick<
    TraceFacets,
    "model" | "tool" | "service" | "environment" | "experiment" | "arm" | "name"
  >;
  /** Null lists every span; otherwise spans are grouped by this key (what v1 called Operations). */
  groupBy: OperationGroupBy | null;
  spans: readonly SpanSummaryView[];
  operations: readonly OperationAggregate[];
  sort: { id: string; direction: SortDirection };
  nextCursor: string | null;
  paged: boolean;
  empty: TracesEmptyKind | null;
  latestAt: string | null;
  widerPreset: { id: RangePreset; label: string } | null;
}

const GROUP_LABEL: Readonly<Record<OperationGroupBy, string>> = {
  name: "Step name",
  model: "Model",
  tool: "Tool",
};

/**
 * Traces, Spans tab (v2): every step across runs, or the same steps grouped by
 * name, model or tool with their latency, failures and spend ("Group by"
 * replaces v1's Operations tab).
 */
export function SpansView(props: SpansViewProps) {
  const { projectId, now, timeWindow, facets, groupBy, empty } = props;
  const { pathname, search, pending, go } = useTraceNavigation();
  const router = useRouter();
  const tracesPath = `/project/${encodeURIComponent(projectId)}/traces`;
  const listSearch = withoutCursor(search);

  return (
    <Page>
      <TracesHeader
        projectId={projectId}
        search={search}
        timeWindow={timeWindow}
        onSearchChange={go}
      />
      <PageBody wide className="gap-6">
        <TraceFilterBar
          tab="spans"
          search={search}
          pending={pending}
          facets={facets}
          onSearchChange={go}
          end={
            <span className="flex items-center gap-2">
              <span className="text-xs text-fg-subtle">Group by</span>
              <SegmentedControl
                label="Group by"
                value={groupBy ?? "none"}
                onValueChange={(value) =>
                  go((current) => withGroupBy(current, value === "none" ? null : value))
                }
                options={[
                  { value: "none", label: "None" },
                  { value: "name", label: "Name" },
                  { value: "model", label: "Model" },
                  { value: "tool", label: "Tool" },
                ]}
              />
            </span>
          }
        />
        {empty ? (
          <div className="rounded-lg border border-line">
            <TracesEmpty
              kind={empty}
              unit="spans"
              projectId={projectId}
              latestAt={props.latestAt}
              onClearFilters={() => go((current) => withoutFilters("spans", current))}
              onWiden={
                props.widerPreset
                  ? {
                      label: `Show ${props.widerPreset.label.toLowerCase()}`,
                      run: () => go((current) => withRangePreset(current, props.widerPreset!.id)),
                    }
                  : undefined
              }
            />
          </div>
        ) : (
          <section
            aria-label={groupBy ? `Steps by ${GROUP_LABEL[groupBy].toLowerCase()}` : "Steps"}
            className={cn(
              "flex flex-col gap-3 transition-opacity duration-160",
              pending && "opacity-60",
            )}
            aria-busy={pending || undefined}
          >
            {groupBy ? (
              <OperationsTable
                rows={props.operations}
                groupBy={groupBy}
                sort={props.sort}
                sortHref={(id) => (direction) => `${pathname}${withSort(search, id, direction)}`}
                onOpen={(row) => go((current) => withDrillDown(current, groupBy, row.key))}
              />
            ) : (
              <>
                <SpansTable
                  rows={props.spans}
                  now={now}
                  sort={props.sort}
                  sortHref={(id) => (direction) => `${pathname}${withSort(search, id, direction)}`}
                  onOpen={(row) =>
                    router.push(
                      `${tracesPath}/${encodeURIComponent(row.traceId)}${withSpan(listSearch, row.spanId)}`,
                    )
                  }
                />
                <ListFooter
                  count={props.spans.length}
                  noun="span"
                  nextHref={
                    props.nextCursor !== null
                      ? `${pathname}${withCursor(search, props.nextCursor)}`
                      : null
                  }
                  firstHref={props.paged ? `${pathname}${listSearch}` : null}
                />
              </>
            )}
          </section>
        )}
      </PageBody>
    </Page>
  );
}

function SpansTable({
  rows,
  now,
  sort,
  sortHref,
  onOpen,
}: {
  rows: readonly SpanSummaryView[];
  now: string;
  sort: { id: string; direction: SortDirection };
  sortHref: (id: SpanSort) => (direction: SortDirection) => string;
  onOpen: (row: SpanSummaryView) => void;
}) {
  const columns: Column<SpanSummaryView>[] = [
    {
      id: "status",
      header: "Status",
      width: "7.5rem",
      cell: (row) => (
        <StatusDot
          tone={row.statusCode === 2 ? "danger" : "success"}
          label={row.statusCode === 2 ? "Failed" : "Completed"}
        />
      ),
    },
    {
      id: "step",
      header: "Step",
      // Narrow screens scroll the table sideways rather than crush this column.
      className: "w-full max-w-0 min-w-48",
      cell: (row) => {
        const named = {
          ...row,
          operationName: row.operationName,
          attributes: row.toolName ? { "gen_ai.tool.name": row.toolName } : {},
        };
        const kind = stepKind(named);
        return (
          <span className="flex min-w-0 items-center gap-2">
            <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", KIND_DOT[kind])} />
            <span className="shrink-0 text-fg-subtle">{STEP_KIND_LABEL[kind]}</span>
            <TruncatedText text={stepTitle(named)} className="text-fg" />
          </span>
        );
      },
    },
    {
      id: "run",
      header: "Run",
      width: "9rem",
      cell: (row) => (
        <span className="font-mono text-xs whitespace-nowrap text-fg-muted">
          {shortId(row.traceId)}
        </span>
      ),
    },
    {
      id: "started",
      header: "Started",
      width: "8.5rem",
      sortHref: sortHref("started"),
      defaultDirection: "desc",
      cell: (row) => <RelativeTime value={row.startedAt} now={now} />,
    },
    {
      id: "duration",
      header: "Duration",
      align: "right",
      width: "6.5rem",
      sortHref: sortHref("duration"),
      cell: (row) => formatDuration(row.durationMs),
    },
    {
      id: "tokens",
      header: "Tokens",
      align: "right",
      width: "6.5rem",
      sortHref: sortHref("tokens"),
      cell: (row) => formatInteger(row.totalTokens),
    },
    {
      id: "cost",
      header: "Cost",
      align: "right",
      width: "6rem",
      sortHref: sortHref("cost"),
      cell: (row) => formatMoney(row.costUsd),
    },
  ];
  return (
    <DataTable
      caption="Steps"
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      onRowOpen={onOpen}
      sort={sort}
    />
  );
}

function OperationsTable({
  rows,
  groupBy,
  sort,
  sortHref,
  onOpen,
}: {
  rows: readonly OperationAggregate[];
  groupBy: OperationGroupBy;
  sort: { id: string; direction: SortDirection };
  sortHref: (id: OperationSortId) => (direction: SortDirection) => string;
  onOpen: (row: OperationAggregate) => void;
}) {
  const columns: Column<OperationAggregate>[] = [
    {
      id: "key",
      header: GROUP_LABEL[groupBy],
      // Narrow screens scroll the table sideways rather than crush this column.
      className: "w-full max-w-0 min-w-48",
      sortHref: sortHref("key"),
      defaultDirection: "asc",
      cell: (row) => <TruncatedText text={row.key} className="text-fg" />,
    },
    {
      id: "count",
      header: "Spans",
      align: "right",
      width: "6rem",
      sortHref: sortHref("count"),
      cell: (row) => formatInteger(row.count),
    },
    {
      id: "errorRate",
      header: "Failed",
      align: "right",
      width: "7rem",
      sortHref: sortHref("errorRate"),
      cell: (row) => (
        <span className="inline-flex items-center justify-end gap-1.5">
          {row.errorCount > 0 ? (
            <span aria-hidden className="size-1.5 rounded-full bg-danger" />
          ) : null}
          {formatPercent(row.errorRate)}
        </span>
      ),
    },
    {
      id: "p50",
      header: "Median",
      align: "right",
      width: "6.5rem",
      sortHref: sortHref("p50"),
      cell: (row) => formatDuration(row.p50DurationMs),
    },
    {
      id: "p95",
      header: "p95",
      align: "right",
      width: "6.5rem",
      sortHref: sortHref("p95"),
      cell: (row) => formatDuration(row.p95DurationMs),
    },
    {
      id: "tokens",
      header: "Tokens",
      align: "right",
      width: "7rem",
      sortHref: sortHref("tokens"),
      cell: (row) => formatInteger(row.totalTokens),
    },
    {
      id: "cost",
      header: "Cost",
      align: "right",
      width: "6rem",
      sortHref: sortHref("cost"),
      cell: (row) => formatMoney(row.costUsd),
    },
  ];
  return (
    <DataTable
      caption={`Steps by ${GROUP_LABEL[groupBy].toLowerCase()}`}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.key}
      onRowOpen={onOpen}
      sort={sort}
    />
  );
}

/** A new grouping starts from its own default order. */
function withGroupBy(search: string, groupBy: string | null): string {
  const params = new URLSearchParams(search.replace(/^\?/, ""));
  if (groupBy) params.set("groupBy", groupBy);
  else params.delete("groupBy");
  for (const name of ["sort", "direction", "cursor", "peek"]) params.delete(name);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** A group's row lists its spans: the grouping goes, its key becomes the filter. */
function withDrillDown(search: string, groupBy: OperationGroupBy, key: string): string {
  const params = new URLSearchParams(search.replace(/^\?/, ""));
  for (const name of ["groupBy", "sort", "direction", "cursor", "peek", "scope"])
    params.delete(name);
  params.set(groupBy === "name" ? "name" : groupBy, key);
  return `?${params.toString()}`;
}

function withSpan(search: string, spanId: string): string {
  const params = new URLSearchParams(search.replace(/^\?/, ""));
  for (const name of ["groupBy", "sort", "direction", "scope"]) params.delete(name);
  params.set("span", spanId);
  return `?${params.toString()}`;
}
