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
import type { RawSpanView, TraceRawRouteResponse } from "@/lib/ingest/otlp-raw/trace-raw-route";
import {
  buildTraceContentView,
  preferSpanContent,
  type TraceContentView,
} from "@/lib/synthesis/traces/content-view";
import { costLabel } from "@/lib/synthesis/traces/v2/cost-label";
import { formatDuration, formatInteger, formatTimestamp } from "@/lib/synthesis/traces/v2/format";
import { runNoun } from "@/lib/synthesis/traces/v2/run-noun";
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
import type { TraceSession } from "@/lib/views/session-chat/trace-session";
import { KIND_ORDER } from "./kind";
import { SpanDetails, SpanInspector } from "./SpanInspector";
import { type RawState, SpanIOPanel } from "./SpanIOPanel";
import { TraceConversation } from "./TraceConversation";
import { type LifecycleRecord, TraceRanking } from "./TraceRanking";
import { TraceSessionBar } from "./TraceSessionBar";
import { TraceTimeline } from "./TraceTimeline";
import { TraceViewsV3Provider } from "./views-v3-context";

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
  /** The run's `events.payload` content, read on the server; the spans' own content wins when they carry any. */
  payloadContent?: TraceContentView | null;
  lifecycle: readonly LifecycleRecord[];
  /** The list this trace was opened from, filters and page included. */
  listHref: string;
  /** The list with this run picked for comparison. */
  compareHref: string;
  initialTab: TraceTab;
  initialSpanId: string | null;
  runtimeEventsRoot: string | null;
  /** Inside another page (the session replay's Trace view): no page frame, a heading row instead. */
  embedded?: boolean;
  /** `cloud-trace-views-v3`: the span pane shows input, output and raw attributes (RC-412). */
  viewsV3?: boolean;
  /** `cloud-trace-views-v3`: the session this turn is part of, and its turns (RC-472). */
  session?: TraceSession | null;
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
  const { payloadContent = null } = props;
  const content = useMemo(
    () => preferSpanContent(buildTraceContentView(rows.map((row) => row.span)), payloadContent),
    [rows, payloadContent],
  );
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

  const raw = useTraceRaw(props.projectId, props.traceId, props.viewsV3 === true);
  // RC-501: a wrapper step shows its nearest model call's content, and links to it.
  const descendants = useMemo(() => {
    const out = [];
    for (
      let index = shown + 1;
      index < rows.length && rows[index]!.depth > rows[shown]!.depth;
      index += 1
    ) {
      const span = rows[index]!.span;
      out.push({
        spanId: span.spanId,
        spanClass: span.spanClass,
        attributes: { ...span.attributes, ...raw.spans.get(span.spanId)?.attributes },
      });
    }
    return out;
  }, [rows, shown, raw.spans]);
  const selectSpan = useCallback(
    (spanId: string) => {
      const index = rows.findIndex((row) => row.span.spanId === spanId);
      if (index >= 0) select(index);
    },
    [rows, select],
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

  const noun = runNoun(props.viewsV3 === true);

  const kindSummary = useMemo(() => summarizeKinds(rows.map((row) => stepKind(row.span))), [rows]);

  const description = `Started ${formatTimestamp(props.startedAt)}${props.service ? ` in ${props.service}` : ""}`;
  const actions = (
    <>
      <CopyButton text={props.traceId} label="Copy trace ID" />
      {raw.state === "ready" && raw.spans.size > 0 ? (
        <a
          href={`${rawUrl(props.projectId, props.traceId)}?format=otlp`}
          download
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          Download OTLP JSON
        </a>
      ) : null}
      <Link
        href={props.compareHref}
        className={buttonVariants({ variant: "secondary", size: "sm" })}
      >
        Compare
      </Link>
    </>
  );
  const body = (
    <>
      {props.truncated ? (
        <Callout tone="warning" title={`This ${noun.lower} is longer than 5,000 spans`}>
          The timeline shows its first 5,000 spans.
        </Callout>
      ) : null}

      <StatRow
        stats={[
          {
            label: "Status",
            value: (
              <span className="inline-flex items-center gap-2">
                <span aria-hidden className={cn("size-2 rounded-full", STATUS_DOT[props.status])} />
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
          { label: "Cost", value: costLabel(totals.costUsd, totals.unpricedCalls ?? 0) },
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
              <div
                className={cn(
                  "grid items-start gap-4",
                  props.viewsV3
                    ? "xl:grid-cols-[minmax(0,1fr)_28rem] 2xl:grid-cols-[minmax(0,1fr)_34rem]"
                    : "xl:grid-cols-[minmax(0,1fr)_22rem]",
                )}
              >
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
                  >
                    {props.viewsV3 ? (
                      <SpanIOPanel
                        key={selectedRow.span.spanId}
                        span={selectedRow.span}
                        raw={raw.spans.get(selectedRow.span.spanId) ?? null}
                        rawState={raw.state}
                        payload={payloadContent}
                        descendants={descendants}
                        turnHasContent={content.contentCaptured}
                        onSelectSpan={selectSpan}
                      />
                    ) : undefined}
                  </SpanInspector>
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
    </>
  );
  // The context gives the conversation its noun ("Turn" with the redesign on).
  if (props.embedded) {
    return (
      <TraceViewsV3Provider enabled={props.viewsV3 === true}>
        <div className="flex flex-col gap-6" data-trace-embedded={props.traceId}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-base font-semibold text-fg">{props.title}</h2>
              <p className="text-ui text-fg-muted">{description}</p>
            </div>
            <div className="flex items-center gap-2">{actions}</div>
          </div>
          {body}
        </div>
      </TraceViewsV3Provider>
    );
  }
  return (
    <TraceViewsV3Provider enabled={props.viewsV3 === true}>
      <Page>
        <PageHeader
          crumbs={[{ label: "Traces", href: props.listHref }]}
          title={props.title}
          description={description}
          actions={actions}
        />
        <PageBody wide className="gap-6">
          {props.session ? (
            <TraceSessionBar projectId={props.projectId} session={props.session} />
          ) : null}
          {body}
        </PageBody>
      </Page>
    </TraceViewsV3Provider>
  );
}

/**
 * The run's raw spans from `otlp_raw_exports`, fetched once when the views
 * redesign is on. A failed read leaves the pane on the stored spans.
 */
function useTraceRaw(
  projectId: string,
  traceId: string,
  enabled: boolean,
): { state: RawState; spans: ReadonlyMap<string, RawSpanView> } {
  const [result, setResult] = useState<{
    state: RawState;
    spans: ReadonlyMap<string, RawSpanView>;
  }>(() => ({
    state: enabled ? "loading" : "ready",
    spans: new Map(),
  }));
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetch(rawUrl(projectId, traceId), { signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as TraceRawRouteResponse;
        if (!body.ok) throw new Error("trace raw read failed");
        setResult({
          state: "ready",
          spans: new Map(body.spans.map((span) => [span.spanId, span])),
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ state: "error", spans: new Map() });
      });
    return () => controller.abort();
  }, [projectId, traceId, enabled]);
  return result;
}

function rawUrl(projectId: string, traceId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(traceId)}/raw`;
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
