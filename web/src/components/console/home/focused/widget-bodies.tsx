import { buttonVariants } from "@ratel/design-system/button-variants";
import { StatRow } from "@ratel/design-system/stat-row";
import { ArrowRight, CircleCheck, Hourglass, Inbox, Lock } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { AttentionList, HealthUnlockRow } from "@/components/console/home/AttentionList";
import { AlertsWidget } from "@/components/console/home/focused/AlertsWidget";
import { HealthWidget } from "@/components/console/home/focused/HealthWidget";
import {
  EmptyAction,
  type EmptyWindow,
  TracesAction,
  WidgetEmpty,
} from "@/components/console/home/focused/WidgetEmpty";
import { focusedStats, isSdkOnly } from "@/components/console/home/overview-stats";
import { TopologyMap } from "@/components/console/topology/TopologyMap";
import { fmtCount } from "@/lib/platform/format";
import { healthUnlockLine } from "@/lib/views/health/unlock";
import type {
  FocusedAttention,
  FocusedOverviewData,
  MetricsData,
} from "@/lib/views/home/focused-load";
import type { OverviewItemId, OverviewWidgetId } from "@/lib/views/overview-layout/domain/layout";

/** Every widget of the Overview, and its dashboard widgets. */
export type WidgetBodies = Readonly<Record<OverviewWidgetId, ReactNode>> &
  Readonly<Partial<Record<OverviewItemId, ReactNode>>>;

type PeekHref = (peek: string) => string;

/** What each widget holds, drawn on the server. Null for a widget the loader did not read. */
export function widgetBodies(
  data: FocusedOverviewData,
  linked: boolean,
  /** Where a Panel opens from somewhere other than the page (an MCP App view); absent, in place. */
  peekHref?: PeekHref,
): Record<OverviewWidgetId, ReactNode> {
  const { metrics, topology, health, attention, alerts, root, rangeParam } = data;
  const at: EmptyWindow = { root, window: data.window, tracesSeen: data.tracesSeen };
  const reload = data.window === 7 ? root : `${root}?range=${rangeParam}`;
  return {
    metrics:
      metrics === "failed" ? (
        <NotLoaded title="These numbers did not load." href={reload} />
      ) : (
        metrics && <Metrics data={metrics} at={at} peekHref={peekHref} />
      ),
    topology:
      topology === "failed" ? (
        <NotLoaded title="The map did not load." href={reload} />
      ) : (
        topology && (
          <TopologyMap
            projectId={data.project.id}
            graph={topology}
            range={rangeParam}
            linked={linked}
            bare
            empty={at}
          />
        )
      ),
    health:
      health?.card.kind === "state" && health.card.reason === "failed" ? (
        <NotLoaded title={health.card.line} href={reload} />
      ) : (
        health && <HealthWidget health={health} at={at} />
      ),
    attention: attention && (
      <NeedsAttention attention={attention} at={at} reload={reload} peekHref={peekHref} />
    ),
    alerts:
      alerts === "failed" ? (
        <NotLoaded title="The alerts did not load." href={reload} />
      ) : (
        alerts && <AlertsWidget alerts={alerts} />
      ),
  };
}

function Metrics({
  data,
  at,
  peekHref,
}: {
  data: MetricsData;
  at: EmptyWindow;
  peekHref?: PeekHref;
}) {
  const stats = focusedStats(data).map(({ peek, ...stat }) =>
    peek && peekHref ? { ...stat, href: peekHref(peek) } : { ...stat, peek },
  );
  const row = (
    <StatRow
      stats={stats}
      // No frame: only the lines between the numbers. A change that does not fit beside its number goes under it.
      className="min-h-0 flex-1 overflow-auto rounded-none border-0 lg:[&>div]:px-3 lg:[&>div]:py-2.5 [&>div:hover]:bg-app [&>div:hover_dt]:text-fg [&_dd]:flex-wrap"
    />
  );
  // The numbers stay: a zero is a zero, and what needs a run is a dash.
  if (data.traces.count > 0 || isSdkOnly(data)) return row;
  return (
    <>
      {row}
      <div
        data-widget-empty="metrics"
        className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-3 py-2"
      >
        <p className="min-w-0 flex-1 basis-56 text-ui text-fg-muted">
          {at.tracesSeen === "none" ? "No traces yet." : `No runs in the last ${at.window} days.`}{" "}
          Send traces to fill in these numbers.
        </p>
        <TracesAction {...at} />
      </div>
    </>
  );
}

function NeedsAttention({
  attention,
  at,
  reload,
  peekHref,
}: {
  attention: FocusedAttention;
  at: EmptyWindow;
  reload: string;
  peekHref?: PeekHref;
}) {
  const { moreIssues, healthHref, partial, healthLock } = attention;
  const items = attention.items.map((item) =>
    item.target.kind === "peek" && peekHref
      ? { ...item, target: { kind: "link" as const, href: peekHref(item.target.peek) } }
      : item,
  );
  if (items.length === 0 && partial)
    return <NotLoaded title="Needs attention did not load." href={reload} />;
  if (items.length === 0) return <NothingListed attention={attention} at={at} />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <AttentionList items={items} bare />
      {partial ? (
        <p className="border-t border-line px-4 py-2.5 text-xs text-fg-subtle">
          Some checks did not load.
        </p>
      ) : null}
      {healthLock ? (
        <HealthUnlockRow lock={healthLock} href={healthHref} className="border-t border-line" />
      ) : null}
      {moreIssues > 0 ? (
        <Link
          href={healthHref}
          className="flex min-h-11 items-center gap-1 border-t border-line px-4 text-ui text-fg-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
        >
          {fmtCount(moreIssues)} more in Agent health
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      ) : null}
    </div>
  );
}

/** An empty list says "nothing" only where everything was checked. */
function NothingListed({
  attention: { state, moreIssues, healthHref, healthLock },
  at,
}: {
  attention: FocusedAttention;
  at: EmptyWindow;
}) {
  const openHealth = <EmptyAction href={healthHref}>Open Agent health</EmptyAction>;
  switch (state) {
    case "no_data":
      return (
        <WidgetEmpty
          name="attention-no-data"
          icon={Inbox}
          title="Nothing to check yet"
          description={`${at.tracesSeen === "none" ? "There are no traces yet." : `Nothing arrived in the last ${at.window} days.`} Send traces, and failed runs, issues and fixes show up here.`}
          action={<TracesAction {...at} />}
        />
      );
    case "collecting":
      return (
        <WidgetEmpty
          name="attention-collecting"
          icon={Hourglass}
          title={healthLock ? healthUnlockLine(healthLock) : "Agent health is still collecting"}
          description="The issues it finds show up here once it unlocks. Failed runs and fixes show up already."
          action={openHealth}
        />
      );
    case "early":
      return (
        <WidgetEmpty
          name="attention-early"
          icon={Hourglass}
          title="Too early to say"
          description="Nothing is found so far. Agent health has no full reading yet, so issues can still show up."
          action={openHealth}
        />
      );
    case "locked":
      return (
        <WidgetEmpty
          name="attention-locked"
          icon={Lock}
          title={`${fmtCount(moreIssues)} ${moreIssues === 1 ? "issue is" : "issues are"} not on your plan`}
          description="Your plan hides what was found. Agent health says how to see it."
          action={openHealth}
        />
      );
    case "clear":
      return (
        <WidgetEmpty
          name="attention-clear"
          icon={CircleCheck}
          title="Nothing needs you right now"
          description="Failed runs, issues and fixes show up here."
          action={openHealth}
        />
      );
  }
}

export function NotLoaded({ title, href }: { title: string; href: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto p-4 text-center">
      <p className="text-sm text-danger">{title}</p>
      <Link href={href} className={buttonVariants({ variant: "secondary", size: "sm" })}>
        Try again
      </Link>
    </div>
  );
}
