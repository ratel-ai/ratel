"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { CodeBlock } from "@ratel/design-system/code";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Page, PageBody } from "@ratel/design-system/page-header";
import { Panel, usePeek } from "@ratel/design-system/panel";
import { EmptyState } from "@ratel/design-system/states";
import { BookOpen } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { formatAttributeValue } from "@/lib/synthesis/traces/format";
import type { TraceFacetValue } from "@/lib/synthesis/traces/queries";
import { withCursor, withoutCursor, withoutFilters } from "@/lib/synthesis/traces/v2/filters";
import { formatTimestamp, shortId } from "@/lib/synthesis/traces/v2/format";
import { experimentLabel, logPresentation } from "@/lib/synthesis/traces/v2/logs";
import { RelativeTime, TruncatedText } from "./cells";
import { useTraceNavigation } from "./navigation";
import { ListFooter } from "./RunsTable";
import { SpanAttributesList } from "./SpanInspector";
import { TraceFilterBar } from "./TraceFilterBar";
import { TRACES_DOCS } from "./TracesEmpty";
import { type TimeWindow, TracesHeader } from "./TracesHeader";

/** A log row as the page sends it: dates as ISO strings. */
export interface LogRow {
  id: string;
  occurredAt: string;
  eventName: string;
  traceId: string | null;
  serviceName: string | null;
  experimentName: string | null;
  experimentArm: string | null;
  experimentRole: string | null;
  body: unknown;
  experimentAttrs: Record<string, unknown>;
  attributes: Record<string, unknown>;
  attrsTruncated: boolean;
}

export interface LogsViewProps {
  projectId: string;
  now: string;
  timeWindow: TimeWindow;
  logs: readonly LogRow[];
  experiments: readonly TraceFacetValue[];
  nextCursor: string | null;
  paged: boolean;
  filtered: boolean;
}

const TONE = {
  neutral: "neutral",
  success: "success",
  warning: "warning",
  danger: "danger",
  info: "info",
} as const;

/**
 * Traces, Logs tab (v2): the Ratel SDK's own records (experiment results,
 * comparisons, delayed outcomes), newest first. A row opens its body and
 * attributes in a Panel.
 */
export function LogsView(props: LogsViewProps) {
  const { projectId, now, timeWindow, logs } = props;
  const { pathname, search, pending, go } = useTraceNavigation();
  const peek = usePeek();
  const [lastId, setLastId] = useState(peek.id);
  if (peek.id && peek.id !== lastId) setLastId(peek.id);
  const tracesPath = `/project/${encodeURIComponent(projectId)}/traces`;
  const listSearch = withoutCursor(search);
  const index = logs.findIndex((log) => log.id === (peek.id ?? lastId));
  const shown = index >= 0 ? logs[index] : null;

  const columns: Column<LogRow>[] = [
    {
      id: "time",
      header: "Time",
      width: "8.5rem",
      cell: (log) => <RelativeTime value={log.occurredAt} now={now} />,
    },
    {
      id: "event",
      header: "Log",
      width: "11rem",
      cell: (log) => {
        const presentation = logPresentation(log.eventName);
        return <Badge tone={TONE[presentation.tone]}>{presentation.label}</Badge>;
      },
    },
    {
      id: "experiment",
      header: "Experiment",
      // Narrow screens scroll the table sideways rather than crush this column.
      className: "w-full max-w-0 min-w-48",
      cell: (log) => <TruncatedText text={experimentLabel(log) ?? ""} className="text-fg-muted" />,
    },
    {
      id: "service",
      header: "Service",
      width: "11rem",
      className: "max-w-44",
      cell: (log) => <TruncatedText text={log.serviceName ?? ""} className="text-fg-muted" />,
    },
    {
      id: "run",
      header: "Run",
      width: "9rem",
      cell: (log) =>
        log.traceId ? (
          <Link
            href={`${tracesPath}/${encodeURIComponent(log.traceId)}${listSearch}`}
            className="rounded font-mono text-xs whitespace-nowrap text-fg-muted underline decoration-line-strong underline-offset-4 outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
          >
            {shortId(log.traceId)}
          </Link>
        ) : (
          <span className="text-xs text-fg-subtle">No run</span>
        ),
    },
  ];

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
          tab="logs"
          search={search}
          pending={pending}
          facets={{
            model: [],
            tool: [],
            service: [],
            environment: [],
            arm: [],
            name: [],
            experiment: [...props.experiments],
          }}
          onSearchChange={go}
        />
        <section
          aria-label="Logs"
          className={cn(
            "flex flex-col gap-3 transition-opacity duration-160",
            pending && "opacity-60",
          )}
          aria-busy={pending || undefined}
        >
          {logs.length === 0 ? (
            <div className="rounded-lg border border-line">
              {props.filtered ? (
                <EmptyState
                  title="No logs match"
                  description="Nothing in this window matches these filters."
                  action={
                    <Button
                      variant="secondary"
                      onClick={() => go((current) => withoutFilters("logs", current))}
                    >
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  emblem
                  title="No logs in this window"
                  description="Ratel SDK records, like experiment results and delayed outcomes, show up here as they arrive."
                  action={
                    <a
                      href={TRACES_DOCS}
                      target="_blank"
                      rel="noreferrer"
                      className={buttonVariants({ variant: "secondary" })}
                    >
                      <BookOpen aria-hidden />
                      Read the docs
                    </a>
                  }
                />
              )}
            </div>
          ) : (
            <>
              <DataTable
                caption="Logs, newest first"
                columns={columns}
                rows={logs}
                rowKey={(log) => log.id}
                onRowOpen={(log) => peek.open(log.id)}
                selectedKey={peek.id}
              />
              <ListFooter
                count={logs.length}
                noun="log"
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
      </PageBody>

      <Panel
        open={peek.id !== null && index >= 0}
        onOpenChange={(open) => {
          if (!open) peek.close();
        }}
        title={shown ? logPresentation(shown.eventName).label : "Log"}
        subtitle={shown ? formatTimestamp(shown.occurredAt) : undefined}
        actions={
          shown?.traceId ? (
            <Link
              href={`${tracesPath}/${encodeURIComponent(shown.traceId)}${listSearch}`}
              className={buttonVariants({ variant: "secondary", size: "sm" })}
            >
              Open run
            </Link>
          ) : null
        }
        onPrevious={index > 0 ? () => peek.open(logs[index - 1].id) : undefined}
        onNext={
          index >= 0 && index < logs.length - 1 ? () => peek.open(logs[index + 1].id) : undefined
        }
      >
        {shown ? <LogDetails log={shown} /> : null}
      </Panel>
    </Page>
  );
}

function LogDetails({ log }: { log: LogRow }) {
  const presentation = logPresentation(log.eventName);
  const facts = [
    { label: "Experiment", value: log.experimentName },
    { label: "Variant", value: log.experimentArm },
    { label: "Service", value: log.serviceName },
    { label: "Log name", value: log.eventName },
  ].filter((fact): fact is { label: string; value: string } => Boolean(fact.value));
  return (
    <div className="flex flex-col gap-6" data-log-details>
      <p className="text-sm text-fg-muted">{presentation.description}.</p>
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-ui">
        {facts.map((fact) => (
          <div key={fact.label} className="contents">
            <dt className="text-fg-subtle">{fact.label}</dt>
            <dd
              className={cn(
                "min-w-0 break-words text-fg",
                fact.label === "Log name" && "font-mono text-xs leading-5",
              )}
            >
              {fact.value}
            </dd>
          </div>
        ))}
      </dl>
      {log.body !== null && log.body !== undefined && log.body !== "" ? (
        <CodeBlock caption="Body" samples={[{ label: "JSON", code: pretty(log.body) }]} />
      ) : null}
      <SpanAttributesList
        title="Experiment attributes"
        attributes={log.experimentAttrs}
        empty="No experiment attributes."
      />
      <SpanAttributesList
        title="Attributes"
        attributes={log.attributes}
        truncated={log.attrsTruncated}
        empty="No attributes."
      />
    </div>
  );
}

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? formatAttributeValue(value);
  } catch {
    return formatAttributeValue(value);
  }
}
