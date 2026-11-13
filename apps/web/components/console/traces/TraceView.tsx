"use client";

import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { CopyButton } from "@ratel/design-system/code";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { StatRow } from "@ratel/design-system/stat-row";
import { Callout } from "@ratel/design-system/states";
import { Tabs } from "@ratel/design-system/tabs";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { buildTraceContentView } from "@/lib/synthesis/traces/content-view";
import {
  formatDuration,
  formatInteger,
  formatMoney,
  formatTimestamp,
} from "@/lib/synthesis/traces/v2/format";
import type { RunTotals } from "@/lib/synthesis/traces/v2/run-summary";
import { INCOMPLETE_HINT, RUN_STATUS_LABEL, type RunStatus } from "@/lib/synthesis/traces/v2/runs";
import { STEP_KIND_LABEL, type StepKind, stepKind } from "@/lib/synthesis/traces/v2/span-kind";
import { nearestVisible, timelineShape } from "@/lib/synthesis/traces/v2/timeline";
import {
  createUrlWriter,
  type QueryUpdates,
  withQueryUpdates,
} from "@/lib/synthesis/traces/v2/url-writer";
import type { TraceWaterfallView } from "@/lib/synthesis/traces/waterfall";
import { KIND_ORDER } from "./kind";
import { SpanDetails, SpanInspector } from "./SpanInspector";
import { TraceConversation } from "./TraceConversation";
import { type LifecycleRecord, TraceRanking } from "./TraceRanking";
import { TraceTimeline } from "./TraceTimeline";

export type TraceTab = "timeline" | "conversation" | "details" | "ranking";

export interface TraceViewProps {
  projectId: string;
  traceId: string;
  /** The ask when captured, else the root span in plain words. */
  title: string;
  service: string | null;
  startedAt: string;
  status: RunStatus;
  totals: RunTotals;
  waterfall: TraceWaterfallView;
  truncated: boolean;
  lifecycle: readonly LifecycleRecord[];
  /** The list this trace was opened from, filters and page included. */
  listHref: string;
  /** The list with this run picked for comparison. */
  compareHref: string;
  initialTab: TraceTab;
  initialSpanId: string | null;
  runtimeEventsRoot: string | null;
}

/**
 * Traces, one run in full (v2): "What happened in this run?" The numbers on
 * top; then the timeline, the conversation, every raw attribute, and the
 * ranking records when an experiment touched the run. The tab and the
 * selected step live in the URL (`?tab=&span=`), so a link lands on both.
 */
export function TraceView(props: TraceViewProps) {
  const { waterfall, totals } = props;
  const rows = waterfall.rows;
  const shape = useMemo(() => timelineShape(rows.map((row) => row.depth)), [rows]);
  const content = useMemo(() => buildTraceContentView(rows.map((row) => row.span)), [rows]);
  const [tab, setTab] = useState<TraceTab>(
    props.lifecycle.length === 0 && props.initialTab === "ranking" ? "timeline" : props.initialTab,
  );
  const [selected, setSelected] = useState(() => {
    const index = rows.findIndex((row) => row.span.spanId === props.initialSpanId);
    return index >= 0 ? index : 0;
  });
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set());
  // Folding away the selected step shows its fold as selected; unfolding brings it back.
  const shown = nearestVisible(shape, collapsed, selected);
  const selectedRow = rows[shown] ?? rows[0];
  const traceStart = waterfall.startedAt ? Date.parse(waterfall.startedAt) : 0;

  // The tab and the step follow into the URL once the selection rests, never
  // on every key press: browsers cap history writes (lib/traces/v2/url-writer.ts).
  const pathname = usePathname();
  const writer = useMemo(
    () =>
      createUrlWriter((updates: QueryUpdates) => {
        // Only this page's own entry: never a page navigated to meanwhile.
        if (window.location.pathname !== pathname) return;
        window.history.replaceState(
          null,
          "",
          `${pathname}${withQueryUpdates(window.location.search, updates)}`,
        );
      }),
    [pathname],
  );
  useEffect(() => () => writer.cancel(), [writer]);

  const select = useCallback(
    (index: number) => {
      setSelected(index);
      const spanId = rows[index]?.span.spanId;
      if (spanId) writer.set({ span: spanId });
    },
    [rows, writer],
  );

  const toggle = useCallback((index: number) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const changeTab = useCallback(
    (next: string) => {
      setTab(next as TraceTab);
      writer.set({ tab: next === "timeline" ? null : next });
    },
    [writer],
  );

  const kindSummary = useMemo(() => summarizeKinds(rows.map((row) => stepKind(row.span))), [rows]);

  return (
    <Page>
      <PageHeader
        crumbs={[{ label: "Traces", href: props.listHref }]}
        title={props.title}
        description={`Started ${formatTimestamp(props.startedAt)}${props.service ? ` in ${props.service}` : ""}`}
        actions={
          <>
            <CopyButton text={props.traceId} label="Copy trace ID" />
            <Link
              href={props.compareHref}
              className={buttonVariants({ variant: "secondary", size: "sm" })}
            >
              Compare
            </Link>
          </>
        }
      />
      <PageBody wide className="gap-6">
        {props.truncated ? (
          <Callout tone="warning" title="This run is longer than 5,000 spans">
            The timeline shows its first 5,000 spans.
          </Callout>
        ) : null}

        <StatRow
          stats={[
            {
              label: "Status",
              value: (
                <span className="inline-flex items-center gap-2">
                  <span
                    aria-hidden
                    className={cn("size-2 rounded-full", STATUS_DOT[props.status])}
                  />
                  {RUN_STATUS_LABEL[props.status]}
                </span>
              ),
              hint:
                totals.failedSpans > 0
                  ? `${formatInteger(totals.failedSpans)} of ${formatInteger(totals.spanCount)} spans failed`
                  : props.status === "incomplete"
                    ? INCOMPLETE_HINT
                    : "Every span succeeded",
            },
            { label: "Duration", value: formatDuration(totals.durationMs) },
            {
              label: "Spans",
              value: formatInteger(totals.spanCount),
              hint: kindSummary || undefined,
            },
            {
              label: "Tokens",
              value: formatInteger(totals.tokens),
              hint:
                totals.tokens > 0
                  ? `${formatInteger(totals.inputTokens)} in, ${formatInteger(totals.outputTokens)} out`
                  : undefined,
            },
            { label: "Cost", value: formatMoney(totals.costUsd) },
          ]}
        />

        <Tabs
          value={tab}
          onValueChange={changeTab}
          items={[
            {
              value: "timeline",
              label: "Timeline",
              content: (
                <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
                  <TraceTimeline
                    rows={rows}
                    durationMs={waterfall.durationMs}
                    shape={shape}
                    collapsed={collapsed}
                    selected={shown}
                    onSelect={select}
                    onToggle={toggle}
                  />
                  {selectedRow ? (
                    <SpanInspector
                      span={selectedRow.span}
                      offsetMs={Math.max(0, Date.parse(selectedRow.span.startedAt) - traceStart)}
                      runtimeEventsRoot={props.runtimeEventsRoot}
                      onShowDetails={() => changeTab("details")}
                    />
                  ) : null}
                </div>
              ),
            },
            {
              value: "conversation",
              label: "Conversation",
              content: <TraceConversation content={content} />,
            },
            {
              value: "details",
              label: "Details",
              content: selectedRow ? (
                <div className="flex max-w-5xl flex-col gap-4">
                  <p className="text-ui text-fg-muted">
                    {STEP_KIND_LABEL[stepKind(selectedRow.span)]}{" "}
                    <span className="font-mono text-xs text-fg">{selectedRow.span.name}</span>
                    <span className="text-fg-subtle">
                      . Pick another step in the timeline to see its attributes.
                    </span>
                  </p>
                  <SpanDetails span={selectedRow.span} traceId={props.traceId} />
                </div>
              ) : null,
            },
            ...(props.lifecycle.length > 0
              ? [
                  {
                    value: "ranking",
                    label: "Ranking",
                    content: <TraceRanking records={props.lifecycle} />,
                  },
                ]
              : []),
          ]}
        />
      </PageBody>
    </Page>
  );
}

/** Status is a dot plus its word; an unfinished run is neither good nor bad. */
const STATUS_DOT: Readonly<Record<RunStatus, string>> = {
  completed: "bg-success",
  failed: "bg-danger",
  incomplete: "bg-fg-subtle",
};

/** "3 model calls, 2 tool calls": the run's shape in a line. */
function summarizeKinds(kinds: readonly StepKind[]): string {
  const counts = new Map<StepKind, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return KIND_ORDER.filter((kind) => kind !== "step" && kind !== "agent" && counts.get(kind))
    .map((kind) => {
      const count = counts.get(kind) ?? 0;
      const label = STEP_KIND_LABEL[kind].toLowerCase();
      return `${formatInteger(count)} ${count === 1 ? label : kind === "search" ? "searches" : `${label}s`}`;
    })
    .join(", ");
}
