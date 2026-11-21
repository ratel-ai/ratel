"use client";

import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Section } from "@ratel/design-system/section";
import { useState } from "react";
import {
  formatCompact,
  formatDuration,
  formatInteger,
  formatPercent,
} from "@/lib/synthesis/traces/v2/format";
import {
  isRoutineHook,
  type RunContext,
  type RunEvent,
  type RunEventKind,
  type RunMetrics,
  type RunRequest,
  type RunTimeSplit,
} from "@/lib/synthesis/traces/v2/run-metrics";
import { TURN_NOUN as noun } from "@/lib/synthesis/traces/v2/run-noun";

const OUTCOME_LABEL: Readonly<Record<string, string>> = {
  ok: "Completed",
  error: "Failed",
  stopped: "Stopped",
};
/** One color per part, in the categorical palette's order: the model and the tools wear their step-kind colors. */
const TIME_PARTS = [
  { key: "modelMs", label: "Model", color: "bg-chart-1" },
  { key: "toolMs", label: "Tools", color: "bg-chart-2" },
  { key: "humanWaitMs", label: "Waiting for a person", color: "bg-chart-4" },
] as const;
export const RUN_EVENT_LABEL: Readonly<Record<RunEventKind, string>> = {
  compaction: "Compaction",
  permission: "Permission",
  hook: "Hook",
  wait: "Wait",
};
/** A marker's color follows its kind; a refusal or a blocked hook is a warning, with its word beside it. */
export const RUN_EVENT_DOT: Readonly<Record<RunEventKind, string>> = {
  compaction: "bg-chart-3",
  permission: "bg-chart-5",
  hook: "bg-fg-subtle",
  wait: "bg-chart-4",
};

/**
 * How a turn ran (AOBS-7): where it ran, where its time went, how its context
 * grew, how much of its input came from the cache, and what happened around
 * its steps. A row of the events table selects the step in the timeline below.
 */
export function TraceRunMetrics({
  metrics,
  onSelect,
}: {
  metrics: RunMetrics;
  onSelect: (spanId: string) => void;
}) {
  const mainRequests = metrics.requests.filter((request) => request.mainAgent);
  return (
    <Section
      title={`How this ${noun.lower} ran`}
      description={metrics.context ? <ContextLine context={metrics.context} /> : undefined}
    >
      <div className="flex flex-col gap-4" data-run-metrics>
        {metrics.timeSplit || mainRequests.length > 0 ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {metrics.timeSplit ? <TimeSplit split={metrics.timeSplit} /> : null}
            {mainRequests.length > 0 ? (
              <ContextGrowth requests={mainRequests} metrics={metrics} onSelect={onSelect} />
            ) : null}
          </div>
        ) : null}
        {metrics.counters.length > 0 ? (
          <dl
            className="flex flex-wrap gap-x-6 gap-y-2 rounded-lg border border-line px-4 py-3 text-ui"
            data-run-counters
          >
            {metrics.counters.map((counter) => (
              <div key={counter.key} className="flex items-baseline gap-2">
                <dt className="text-fg-subtle">{counter.label}</dt>
                <dd className="text-fg tabular-nums">{formatInteger(counter.value)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {metrics.events.length > 0 ? (
          <RunEvents events={metrics.events} counts={metrics.eventCounts} onSelect={onSelect} />
        ) : null}
      </div>
    </Section>
  );
}

function ContextLine({ context }: { context: RunContext }) {
  const facts: [string, string | null][] = [
    ["Repository", context.repo],
    ["Branch", context.branch],
    ["Worktree", context.worktree],
    ["Task", context.task],
    ["Pull request", context.pr !== null ? `#${context.pr}` : null],
    ["Harness", [context.harness, context.harnessVersion].filter(Boolean).join(" ") || null],
    ["Permission mode", context.permissionMode],
    ["Effort", context.effort],
    ["Outcome", context.outcome ? (OUTCOME_LABEL[context.outcome] ?? context.outcome) : null],
  ];
  return (
    <span className="flex flex-wrap gap-x-4 gap-y-1" data-run-context>
      {facts.map(([label, value]) =>
        value ? (
          <span key={label} className="whitespace-nowrap">
            {label} <span className="text-fg">{value}</span>
          </span>
        ) : null,
      )}
    </span>
  );
}

/** Shares of a whole: one stacked bar, each part labeled with its time and share. */
function TimeSplit({ split }: { split: RunTimeSplit }) {
  // A turn that never waited for a person has no such part to show.
  const parts = TIME_PARTS.filter(
    (part) => part.key !== "humanWaitMs" || split.humanWaitMs > 0,
  ).map((part) => ({
    ...part,
    ms: split[part.key],
    share: split.totalMs > 0 ? split[part.key] / split.totalMs : 0,
  }));
  const summary = parts
    .map((part) => `${part.label} ${formatDuration(part.ms)} (${formatPercent(part.share)})`)
    .join(", ");
  return (
    <figure className="flex flex-col gap-3 rounded-lg border border-line p-4" data-time-split>
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-fg-subtle">Time</span>
        <span className="text-xs text-fg-subtle tabular-nums">
          {formatDuration(split.totalMs)} in total
        </span>
      </figcaption>
      <div
        role="img"
        aria-label={`Time split: ${summary}`}
        className="flex h-3 gap-0.5 overflow-hidden rounded-[4px]"
      >
        {parts.map((part) =>
          part.ms > 0 ? (
            <span
              key={part.key}
              title={`${part.label}: ${formatDuration(part.ms)}`}
              className={cn("h-full min-w-[2px]", part.color)}
              style={{ width: `${part.share * 100}%` }}
            />
          ) : null,
        )}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-baseline gap-x-3 gap-y-1.5 text-ui">
        {parts.map((part) => (
          <div key={part.key} className="contents">
            <dt className="flex items-center">
              <span aria-hidden className={cn("size-2 rounded-[2px]", part.color)} />
            </dt>
            <dd className="text-fg-muted">{part.label}</dd>
            <dd className="text-right text-fg tabular-nums">{formatDuration(part.ms)}</dd>
            <dd className="w-12 text-right text-fg-subtle tabular-nums">
              {formatPercent(part.share)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-fg-subtle">
        Model calls that run at the same time count once. Tools is the time that is left.
      </p>
    </figure>
  );
}

/** Change over requests: one bar for each model request of the main agent, against its context window. */
function ContextGrowth({
  requests,
  metrics,
  onSelect,
}: {
  requests: readonly RunRequest[];
  metrics: RunMetrics;
  onSelect: (spanId: string) => void;
}) {
  const peak = metrics.peakContextTokens ?? 0;
  const scale = Math.max(peak, metrics.contextWindow ?? 0);
  const others = metrics.requests.length - requests.length;
  return (
    <figure className="flex flex-col gap-3 rounded-lg border border-line p-4" data-context-growth>
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-fg-subtle">Context for each request</span>
        {metrics.cache ? (
          <span
            className="text-xs text-fg-subtle tabular-nums"
            title={`${formatInteger(metrics.cache.cachedTokens)} of ${formatInteger(metrics.cache.inputTokens)} input tokens came from the cache`}
          >
            Cache hit rate <span className="text-fg">{formatPercent(metrics.cache.hitRate)}</span>
          </span>
        ) : null}
      </figcaption>
      <div className="relative h-24">
        <span
          aria-hidden
          className="absolute top-0 left-0 text-xs leading-5 text-fg-subtle tabular-nums"
        >
          {formatCompact(scale)}
          {metrics.contextWindow ? " window" : " tokens"}
        </span>
        <div aria-hidden className="absolute inset-x-0 top-6 border-t border-dashed border-line" />
        <div aria-hidden className="absolute inset-x-0 bottom-0 border-t border-line" />
        <ol
          className="absolute inset-0 flex items-end gap-0.5 pt-6"
          aria-label="Context size of each model request, in order"
        >
          {requests.map((request, index) => {
            const label = `Request ${index + 1}: ${formatInteger(request.contextTokens)} tokens`;
            return (
              <li key={request.spanId} className="flex h-full max-w-6 min-w-0 flex-1 items-end">
                <button
                  type="button"
                  title={label}
                  aria-label={label}
                  onClick={() => onSelect(request.spanId)}
                  className="group flex h-full w-full items-end rounded-t-[4px] outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <span
                    aria-hidden
                    className="block w-full rounded-t-[4px] bg-chart-1 transition-opacity duration-120 group-hover:opacity-80"
                    style={{
                      height: scale > 0 ? `max(2px, ${(request.contextTokens / scale) * 100}%)` : 0,
                    }}
                  />
                </button>
              </li>
            );
          })}
        </ol>
      </div>
      <p className="text-xs text-fg-subtle tabular-nums">
        {formatInteger(requests.length)} {requests.length === 1 ? "request" : "requests"},{" "}
        {formatInteger(peak)} tokens at the largest
        {metrics.contextWindow
          ? ` (${formatPercent(peak / metrics.contextWindow)} of the window)`
          : ""}
        .{others > 0 ? ` ${formatInteger(others)} more by sub-agents are not shown.` : ""}
      </p>
    </figure>
  );
}

/**
 * The events in time order. A hook that ran without trouble is routine, and a
 * turn can carry 200 of them: they stay folded until asked for, so the
 * compactions, the permission decisions and the waits read first.
 */
function RunEvents({
  events,
  counts,
  onSelect,
}: {
  events: readonly RunEvent[];
  counts: Readonly<Record<RunEventKind, number>>;
  onSelect: (spanId: string) => void;
}) {
  const [withHooks, setWithHooks] = useState(false);
  const quietHooks = events.filter(isRoutineHook).length;
  const shown = withHooks ? events : events.filter((event) => !isRoutineHook(event));
  const summary = (Object.keys(RUN_EVENT_LABEL) as RunEventKind[])
    .filter((kind) => counts[kind] > 0)
    .map(
      (kind) =>
        `${formatInteger(counts[kind])} ${RUN_EVENT_LABEL[kind].toLowerCase()}${counts[kind] === 1 ? "" : "s"}`,
    )
    .join(", ");
  const columns: Column<RunEvent & { id: string }>[] = [
    {
      id: "at",
      header: "At",
      width: "8rem",
      cell: (row) => (
        <span className="whitespace-nowrap text-fg-muted tabular-nums">
          +{formatDuration(row.offsetMs)}
        </span>
      ),
    },
    {
      id: "event",
      header: "Event",
      width: "16rem",
      cell: (row) => (
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden className={cn("size-2 shrink-0 rotate-45", RUN_EVENT_DOT[row.kind])} />
          <span className="truncate text-fg">{row.label}</span>
        </span>
      ),
    },
    {
      id: "detail",
      header: "Detail",
      className: "w-full max-w-0 min-w-40",
      cell: (row) => (
        <span
          className={cn("block truncate", row.tone === "warning" ? "text-fg" : "text-fg-muted")}
          title={row.detail}
        >
          {row.detail || "—"}
        </span>
      ),
    },
  ];
  return (
    <div className="flex flex-col gap-2" data-run-events>
      <p className="text-ui text-fg-muted">Around the steps: {summary}.</p>
      {shown.length > 0 ? (
        <DataTable
          caption="Compactions, permission decisions, hooks and waits"
          density="compact"
          columns={columns}
          rows={shown.map((event, index) => ({ ...event, id: `${event.spanId}:${index}` }))}
          rowKey={(row) => row.id}
          onRowOpen={(row) => onSelect(row.spanId)}
        />
      ) : null}
      {quietHooks > 0 ? (
        <div>
          <Button size="sm" variant="secondary" onClick={() => setWithHooks((current) => !current)}>
            {withHooks
              ? "Hide the hooks that passed"
              : `Show ${formatInteger(quietHooks)} ${quietHooks === 1 ? "hook" : "hooks"} that passed`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
