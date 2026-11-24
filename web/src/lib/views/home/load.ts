import { projectRoot } from "@/lib/console/navigation";
import {
  agentHealthHref,
  type HealthPageModel,
  type HealthTile,
  healthReadiness,
  type WindowDays,
} from "@/lib/readings/trace-signals/view";
import type { Suggestion } from "@/lib/synthesis/dashboard";
import type { TraceAggregateSummary, TraceDailyAggregate } from "@/lib/synthesis/traces/queries";
import { fixHref } from "@/lib/views/fixes/href";
import type { Fix } from "@/lib/views/fixes/types";
import { type Attention, buildAttention } from "@/lib/views/home/attention";
import { CONTEXT_PEEK } from "@/lib/views/home/context-peek";
import {
  applicableDescriptions,
  descriptionsHref,
  type FixesSlice,
  type TasksGlance,
  type UnansweredIntent,
} from "@/lib/views/home/glance";
import {
  type ContextSplit,
  dailyFailureShares,
  dailyReadings,
  type OverviewWindow,
  overviewRangeParam,
} from "@/lib/views/home/overview-model";
import type { SdkActivity, SdkDay } from "@/lib/views/home/overview-reads";

/**
 * The Overview's rules: its reads (`overview-reads.ts`) as the numbers and "Needs attention" that
 * `focused-load.ts` puts on the page. Pure, so each is tested without a database.
 */

export interface OverviewProject {
  id: string;
  name: string;
  slug: string;
  isDemo: boolean;
}

export interface OverviewHealth {
  href: string;
  /** The Agent health window, which the plan may cap below the Overview's. */
  windowDays: WindowDays;
  /** The first try tile once there is a reading; null while collecting. */
  firstTry: HealthTile | null;
}

/** The readings under the stats, one per day of the window; null on a day without one. */
export interface OverviewDaily {
  /** Each day's failed share of its runs. */
  failedShare: (number | null)[];
  /** Each day's average run duration, in ms. */
  duration: (number | null)[];
  /** Each day's spend. */
  spend: (number | null)[];
}

/** SDK events in the window (with each day's) and the window before. A project can send these without any traces. */
export interface OverviewSdk {
  current: SdkActivity;
  previous: SdkActivity | null;
  days: SdkActivity[];
}

/** "Needs attention" from its reads. `fixes` is null when it could not be read. */
export function overviewAttention({
  projectId,
  window,
  traces,
  health,
  healthWindow,
  fixes,
  pendingRewrites,
  tasks,
  unanswered,
  contextSuggestions,
  contextSplit,
}: {
  projectId: string;
  window: OverviewWindow;
  traces: Pick<TraceAggregateSummary, "count" | "errorCount"> | null;
  /** Cut to the plan; null when Agent health is off. */
  health: Pick<HealthPageModel, "signals" | "lockedCount"> | null;
  healthWindow: WindowDays;
  fixes: FixesSlice | null;
  pendingRewrites: number | null;
  tasks: Pick<TasksGlance, "byId" | "steps">;
  unanswered: readonly UnansweredIntent[];
  contextSuggestions: readonly Suggestion[];
  contextSplit: ContextSplit | null;
}): Attention {
  const root = projectRoot(projectId);
  const healthHref = health ? agentHealthHref(projectId, healthWindow) : null;
  // An issue opens the fix that resolves it, when Fixes has one.
  const fixLinks = new Map<string, string>();
  for (const fix of [...(fixes?.open ?? []), ...(fixes?.applied ?? [])]) {
    for (const issue of fix.issues)
      if (!fixLinks.has(issue.id)) fixLinks.set(issue.id, fixTarget(projectId, fix));
  }
  // What Fixes can apply, plan included; Quality's own count when Fixes could not be read.
  const rewrites = fixes
    ? fixes.rewritesOn
      ? applicableDescriptions(fixes)
      : null
    : pendingRewrites;
  return buildAttention({
    errors: {
      count: traces?.errorCount ?? 0,
      total: traces?.count ?? 0,
      href: `${root}/traces?range=${overviewRangeParam(window)}&errorOnly=1`,
    },
    issues: health?.signals ?? [],
    lockedIssues: health?.lockedCount ?? 0,
    issueHref: (issueId) => (healthHref ? issuePanelHref(healthHref, issueId) : root),
    fixHref: (issueId) => fixLinks.get(issueId) ?? null,
    healthHref,
    tasks: tasks.byId,
    taskSteps: tasks.steps,
    unanswered,
    pendingRewrites:
      rewrites === null ? null : { count: rewrites, href: descriptionsHref(projectId) },
    contextSuggestions,
    contextSplit,
    contextPeek: CONTEXT_PEEK,
  });
}

/** The SDK activity under the stats; null when it could not be read. */
export function overviewSdk(
  { sdkDays, sdkPrevious }: { sdkDays: SdkDay[] | null; sdkPrevious: SdkActivity | null },
  days: readonly string[],
): OverviewSdk | null {
  if (!sdkDays) return null;
  const byDay = new Map(sdkDays.map((row) => [row.day, row]));
  return {
    current: sumSdk(sdkDays),
    previous: sdkPrevious,
    days: days.map((day) => {
      const row = byDay.get(day);
      return {
        searches: row?.searches ?? 0,
        toolCalls: row?.toolCalls ?? 0,
        skillRuns: row?.skillRuns ?? 0,
      };
    }),
  };
}

/** The days under the trace stats. */
export function overviewDaily(
  {
    traces,
    dailyTraces,
  }: { traces: TraceAggregateSummary | null; dailyTraces: TraceDailyAggregate[] | null },
  days: readonly string[],
): OverviewDaily {
  const rows = dailyTraces ?? [];
  return {
    failedShare: dailyFailureShares(traces?.volume ?? [], days),
    duration: dailyReadings(rows, days, (row) =>
      row.traceCount > 0 ? row.averageLatencyMs : null,
    ),
    spend: dailyReadings(rows, days, (row) => (row.traceCount > 0 ? row.costUsd : null)),
  };
}

/** The first try tile once there is a reading, for the stat row. */
export function firstTryTile(health: HealthPageModel): HealthTile | null {
  if (healthReadiness(health) !== "ready") return null;
  return (
    health.tiles.find(
      (tile) => (tile.key === "top_5" || tile.key === "first_try") && tile.value !== null,
    ) ?? null
  );
}

/** An issue's panel on Agent health, landing on its row too. */
export function issuePanelHref(healthHref: string, issueId: string): string {
  const [path, query] = healthHref.split("?");
  const params = new URLSearchParams(query ?? "");
  params.set("peek", `issue:${issueId}`);
  // The signal card's anchor (`signalAnchorId` in components/console/health/anchors.ts),
  // spelled here because lib/ never imports the UI.
  return `${path}?${params.toString()}#signal-${issueId}`;
}

/**
 * Where a fix opens: a description update on Quality › Descriptions (its
 * rewrite when Quality drafted it, else its tool), any other fix on Fixes.
 */
export function fixTarget(
  projectId: string,
  fix: Pick<Fix, "id" | "kind" | "source" | "subject">,
): string {
  if (fix.kind === "rewrite") {
    if (fix.source === "rewrite") return descriptionsHref(projectId, { peek: fix.id });
    const tool = fix.subject.tools[0]?.id;
    if (tool) return descriptionsHref(projectId, { tool });
  }
  return fixHref(projectId, { peek: fix.id });
}

function sumSdk(days: readonly SdkActivity[]): SdkActivity {
  return days.reduce(
    (sum, day) => ({
      searches: sum.searches + day.searches,
      toolCalls: sum.toolCalls + day.toolCalls,
      skillRuns: sum.skillRuns + day.skillRuns,
    }),
    { searches: 0, toolCalls: 0, skillRuns: 0 },
  );
}
