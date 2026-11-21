"use client";

import { SegmentedControl } from "@ratel/design-system/tabs";
import { usePathname, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { formatDuration, formatInteger, formatMoney } from "@/lib/synthesis/traces/v2/format";
import {
  parseTracesWindow,
  TRACES_WINDOW_LABEL,
  TRACES_WINDOW_PARAM,
  TRACES_WINDOWS,
  type TracesTab,
  type TracesTabSummary,
  type TracesWindow,
  withTracesWindow,
} from "@/lib/synthesis/traces-sessions/timeframe";
import { MiniVolume } from "./MiniVolume";

/** A tab's summary as the tab holds it: loading until the first answer arrives. */
export type TabSummaryState =
  | TracesTabSummary
  | { status: "loading"; tab: TracesTab; window: TracesWindow };

const SHORT_LABEL: Readonly<Record<TracesWindow, string>> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};
const TAB_LABEL: Readonly<Record<TracesTab, string>> = {
  sessions: "Sessions",
  spans: "Spans",
  logs: "Logs",
};
/** What the chart counts, and what it calls the red part. */
const VOLUME_UNIT: Readonly<Record<TracesTab, { unit: string; errors: string }>> = {
  sessions: { unit: "sessions", errors: "failed" },
  spans: { unit: "spans", errors: "errors" },
  logs: { unit: "logs", errors: "errors" },
};
/** Kinds and levels shown by name; the rest are counted in the total. */
const TOP_GROUPS = 3;

/**
 * The summary at the top of a Traces tab (RC-331):
 * a timeframe and that tab's own numbers and volume. The timeframe lives in
 * `?window=` and changes in place (a history update, not a navigation), so
 * the tab's list under it is not read again.
 */
export function TabSummary({ projectId, tab }: { projectId: string; tab: TracesTab }) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const window = parseTracesWindow(searchParams.getAll(TRACES_WINDOW_PARAM));
  // The answer is kept with the window it was read for: a new window reads as loading until its own answer arrives.
  const key = `${projectId}:${tab}:${window}`;
  const [loaded, setLoaded] = useState<{ key: string; state: TabSummaryState } | null>(null);
  const state: TabSummaryState =
    loaded?.key === key ? loaded.state : { status: "loading", tab, window };

  useEffect(() => {
    const controller = new AbortController();
    const key = `${projectId}:${tab}:${window}`;
    fetch(
      `/api/projects/${encodeURIComponent(projectId)}/traces/summary?tab=${tab}&${TRACES_WINDOW_PARAM}=${window}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const body = (await response.json()) as { ok: boolean; data?: TracesTabSummary };
        setLoaded({
          key,
          state:
            response.ok && body.ok && body.data
              ? body.data
              : { status: "unavailable", tab, window },
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.error("traces tab summary read failed", error);
        setLoaded({ key, state: { status: "unavailable", tab, window } });
      });
    return () => controller.abort();
  }, [projectId, tab, window]);

  return (
    <TabSummaryView
      state={state}
      onWindowChange={(next) => {
        // In place: Next keeps useSearchParams in step with history updates, and the page is not re-rendered.
        globalThis.history.replaceState(
          null,
          "",
          `${pathname}${withTracesWindow(searchParams.toString(), next)}`,
        );
      }}
    />
  );
}

/** The summary as drawn, for a given state. */
export function TabSummaryView({
  state,
  onWindowChange,
}: {
  state: TabSummaryState;
  onWindowChange: (window: TracesWindow) => void;
}) {
  return (
    <section
      aria-label={`${TAB_LABEL[state.tab]} summary`}
      data-tab-summary={state.tab}
      data-window={state.window}
      className="flex flex-col gap-3 rounded-lg border border-line bg-raised px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-ui font-medium text-fg">{TRACES_WINDOW_LABEL[state.window]}</h2>
        <SegmentedControl
          label="Timeframe"
          value={state.window}
          onValueChange={onWindowChange}
          options={TRACES_WINDOWS.map((window) => ({ value: window, label: SHORT_LABEL[window] }))}
        />
      </div>
      <Body state={state} />
    </section>
  );
}

function Body({ state }: { state: TabSummaryState }): ReactNode {
  if (state.status === "loading") {
    return (
      <p
        className="flex min-h-20 items-center text-ui text-fg-subtle"
        aria-busy="true"
        data-summary-state="loading"
      >
        Reading {TRACES_WINDOW_LABEL[state.window].toLowerCase()}…
      </p>
    );
  }
  if (state.status === "unavailable") {
    return (
      <p
        className="flex min-h-20 items-center text-ui text-fg-subtle"
        data-summary-state="unavailable"
      >
        The numbers for {TRACES_WINDOW_LABEL[state.window].toLowerCase()} are not available right
        now. The list below still works.
      </p>
    );
  }
  const { unit, errors } = VOLUME_UNIT[state.tab];
  return (
    <SummaryNumbers
      figures={figures(state)}
      chart={
        <MiniVolume
          model={state.volume}
          unit={unit}
          errorLabel={errors}
          className="min-w-60 flex-1"
        />
      }
    />
  );
}

/** A summary's numbers beside its volume chart: the layout every Traces tab shares (RC-752: Turns too). */
export function SummaryNumbers({ figures, chart }: { figures: ReactNode; chart: ReactNode }) {
  return (
    <div className="flex flex-col gap-x-8 gap-y-3 lg:flex-row lg:items-end" data-summary-state="ok">
      <dl className="flex shrink-0 flex-wrap gap-x-6 gap-y-2">{figures}</dl>
      {chart}
    </div>
  );
}

/** One number of a summary, with an optional quiet line under it. */
export function SummaryFigure({
  label,
  value,
  hint,
  danger,
}: {
  label: string;
  value: string;
  hint?: ReactNode;
  danger?: boolean;
}) {
  return (
    <div className="flex flex-col" data-figure={label}>
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd
        className={
          danger
            ? "text-lg font-semibold text-danger tabular-nums"
            : "text-lg font-semibold text-fg tabular-nums"
        }
      >
        {value}
      </dd>
      {hint ? <dd className="text-xs text-fg-subtle tabular-nums">{hint}</dd> : null}
    </div>
  );
}

function figures(state: TracesTabSummary & { status: "ok" }): ReactNode {
  if (state.tab === "sessions") {
    return (
      <>
        <SummaryFigure label="Sessions" value={formatInteger(state.sessions)} />
        <SummaryFigure
          label="Failed"
          value={formatInteger(state.failed)}
          danger={state.failed > 0}
        />
        <SummaryFigure
          label="Typical duration"
          value={state.typicalDurationMs === null ? "–" : formatDuration(state.typicalDurationMs)}
        />
        <SummaryFigure label="Cost" value={formatMoney(state.costUsd)} />
      </>
    );
  }
  if (state.tab === "spans") {
    return (
      <>
        <SummaryFigure label="Spans" value={formatInteger(state.spans)} />
        <SummaryFigure
          label="Errors"
          value={formatInteger(state.errors)}
          danger={state.errors > 0}
        />
        <SummaryFigure
          label="p50"
          value={state.p50DurationMs === null ? "–" : formatDuration(state.p50DurationMs)}
        />
        <SummaryFigure
          label="p95"
          value={state.p95DurationMs === null ? "–" : formatDuration(state.p95DurationMs)}
        />
        <Groups
          label="By kind"
          groups={state.kinds.map((row) => ({ name: row.kind, count: row.count }))}
        />
      </>
    );
  }
  return (
    <>
      <SummaryFigure label="Logs" value={formatInteger(state.logs)} />
      <SummaryFigure label="Errors" value={formatInteger(state.errors)} danger={state.errors > 0} />
      <Groups
        label="By level"
        groups={state.levels.map((row) => ({
          name: row.level,
          count: row.count,
          danger: row.level === "error" || row.level === "fatal",
        }))}
      />
    </>
  );
}

function Groups({
  label,
  groups,
}: {
  label: string;
  groups: { name: string; count: number; danger?: boolean }[];
}) {
  return (
    <div className="flex flex-col" data-figure={label}>
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd className="flex min-h-7 flex-wrap items-baseline gap-x-3 text-ui text-fg-muted">
        {groups.length === 0 ? <span>–</span> : null}
        {groups.slice(0, TOP_GROUPS).map((group) => (
          <span key={group.name}>
            {group.name}{" "}
            <span
              className={
                group.danger
                  ? "font-medium text-danger tabular-nums"
                  : "font-medium text-fg tabular-nums"
              }
            >
              {formatInteger(group.count)}
            </span>
          </span>
        ))}
        {groups.length > TOP_GROUPS ? <span>+{groups.length - TOP_GROUPS} more</span> : null}
      </dd>
    </div>
  );
}
