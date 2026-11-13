import { DotSpark } from "@ratel/design-system/dot-matrix";
import type { StatDelta, StatProps } from "@ratel/design-system/stat-row";
import type { ReactNode } from "react";
import { fmtCost } from "@/lib/platform/format";
import { formatSharePercent } from "@/lib/readings/trace-signals/claims";
import { formatDuration } from "@/lib/synthesis/traces/format";
import type { TraceAggregateSummary } from "@/lib/synthesis/traces/queries";
import { CONTEXT_PEEK, type OverviewData } from "@/lib/views/home/load";
import {
  type Change,
  compactCount,
  hasTrend,
  NO_VALUE,
  percentChange,
  pointChange,
  pointDelta,
} from "@/lib/views/home/overview-model";

/**
 * The Overview's stat row (DESIGN.md, Numbers): each number with its change
 * and a spark of its days, nothing else. The counts behind a number are one
 * click away, on the page the stat opens.
 */

/**
 * A project that sends SDK events (searches, tool calls) but no traces in the
 * window: its numbers come from those events, and the trace-only ones (runs,
 * duration, spend) would only read as zero.
 */
export function isSdkOnly(data: Pick<OverviewData, "traces" | "sdk">): boolean {
  if (!data.sdk || (data.traces?.count ?? 0) > 0) return false;
  const { searches, toolCalls, skillRuns } = data.sdk.current;
  return searches + toolCalls + skillRuns > 0;
}

function toDelta(
  change: Change | null,
  goodWhen: "up" | "down" | null,
  label: string,
): StatDelta | undefined {
  if (!change) return undefined;
  return {
    value: change.text,
    direction: change.direction,
    good: goodWhen === null || change.direction === "flat" ? null : change.direction === goodWhen,
    label,
  };
}

/** The spark under a stat, when its days have anything to draw. */
function spark(values: readonly (number | null)[], label: string): ReactNode {
  return hasTrend(values) ? <DotSpark values={values} label={label} /> : undefined;
}

/** First try, from Agent health, once it has a reading; null before. */
function firstTryStat(data: OverviewData): StatProps | null {
  const health = data.health;
  const tile = health?.firstTry;
  if (!health || !tile || tile.value === null) return null;
  return {
    label: "First try",
    value: formatSharePercent(tile.value),
    delta: toDelta(
      pointDelta(tile.delta),
      tile.upIsGood ? "up" : "down",
      `vs previous ${health.windowDays} days`,
    ),
    // Said only when the plan reads Agent health over another window than the page's.
    hint: health.windowDays === data.window ? undefined : `Last ${health.windowDays} days`,
    trend: spark(
      tile.series.map((point) => point.value),
      `First try per day, last ${health.windowDays} days`,
    ),
    href: health.href,
  };
}

/** Runs, first try (or failures), median duration and spend, each with its change and its days. */
export function overviewStats(data: OverviewData, traces: TraceAggregateSummary): StatProps[] {
  if (isSdkOnly(data) && data.sdk) return sdkStats(data, data.sdk);
  const { previous, root, rangeParam, window, daily } = data;
  const versus = `vs the same time ${window} days earlier`;
  const tracesHref = `${root}/traces?range=${rangeParam}`;
  const hasRuns = traces.count > 0;
  const days = `last ${window} days`;

  const runs: StatProps = {
    label: "Runs",
    value: compactCount(traces.count),
    delta: toDelta(previous ? percentChange(traces.count, previous.count) : null, null, versus),
    trend: spark(data.series, `Runs per day, ${days}`),
    hint: hasRuns ? undefined : `None in the last ${window} days`,
    href: tracesHref,
  };

  const quality: StatProps = firstTryStat(data) ?? {
    label: "Failed runs",
    value: hasRuns ? formatSharePercent(traces.errorRate) : NO_VALUE,
    delta: toDelta(
      previous && previous.count > 0 && hasRuns
        ? pointChange(traces.errorRate, previous.errorRate)
        : null,
      "down",
      versus,
    ),
    trend: spark(daily.failedShare, `Failed share of runs per day, ${days}`),
    href: `${tracesHref}&errorOnly=1`,
  };

  const duration: StatProps = {
    label: "Median duration",
    value: traces.p50DurationMs === null ? NO_VALUE : formatDuration(traces.p50DurationMs),
    delta: toDelta(
      traces.p50DurationMs !== null && previous && previous.p50DurationMs !== null
        ? percentChange(traces.p50DurationMs, previous.p50DurationMs)
        : null,
      "down",
      versus,
    ),
    trend: spark(daily.duration, `Average duration per day, ${days}`),
    href: `${tracesHref}&sort=duration&direction=desc`,
  };

  const spend: StatProps = {
    label: "Spend",
    value: fmtCost(traces.costUsd),
    delta: toDelta(previous ? percentChange(traces.costUsd, previous.costUsd) : null, null, versus),
    trend: spark(daily.spend, `Spend per day, ${days}`),
    peek: CONTEXT_PEEK,
  };

  return [runs, quality, duration, spend];
}

/**
 * The numbers for a project that sends SDK events but no traces: searches,
 * first try when Agent health has a reading, tool calls (or skill runs).
 * Duration and spend need traces, so they are left out rather than shown as 0.
 */
function sdkStats(data: OverviewData, sdk: NonNullable<OverviewData["sdk"]>): StatProps[] {
  const { root, rangeParam, window } = data;
  const versus = `vs the same time ${window} days earlier`;
  const eventsHref = `${root}/traces/logs?range=${rangeParam}`;
  const { current, previous, days } = sdk;
  const per = (what: string) => `${what} per day, last ${window} days`;
  const searches: StatProps = {
    label: "Searches",
    value: compactCount(current.searches),
    delta: toDelta(
      previous ? percentChange(current.searches, previous.searches) : null,
      null,
      versus,
    ),
    trend: spark(
      days.map((day) => day.searches),
      per("Searches"),
    ),
    href: eventsHref,
  };
  const toolCalls: StatProps = {
    label: "Tool calls",
    value: compactCount(current.toolCalls),
    delta: toDelta(
      previous ? percentChange(current.toolCalls, previous.toolCalls) : null,
      null,
      versus,
    ),
    trend: spark(
      days.map((day) => day.toolCalls),
      per("Tool calls"),
    ),
    href: eventsHref,
  };
  const firstTry = firstTryStat(data);
  if (firstTry) return [searches, firstTry, toolCalls];
  return [
    searches,
    toolCalls,
    {
      label: "Skill runs",
      value: compactCount(current.skillRuns),
      delta: toDelta(
        previous ? percentChange(current.skillRuns, previous.skillRuns) : null,
        null,
        versus,
      ),
      trend: spark(
        days.map((day) => day.skillRuns),
        per("Skill runs"),
      ),
      href: eventsHref,
    },
  ];
}
