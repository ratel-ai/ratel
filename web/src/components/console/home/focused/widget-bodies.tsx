import { buttonVariants } from "@ratel/design-system/button-variants";
import { StatRow } from "@ratel/design-system/stat-row";
import { EmptyState } from "@ratel/design-system/states";
import { ArrowRight, CircleCheck } from "lucide-react";
import Link from "next/link";
import { AttentionList } from "@/components/console/home/AttentionList";
import { HealthWidget } from "@/components/console/home/focused/HealthWidget";
import type { WidgetBody } from "@/components/console/home/focused/OverviewGrid";
import { focusedStats } from "@/components/console/home/overview-stats";
import { TopologyMap } from "@/components/console/topology/TopologyMap";
import { fmtCount } from "@/lib/platform/format";
import { agentsHref } from "@/lib/views/agents/paths";
import type {
  FocusedAttention,
  FocusedOverviewData,
  MetricsData,
} from "@/lib/views/home/focused-load";
import type { OverviewWidgetId } from "@/lib/views/overview-layout/domain/layout";

/** What each card holds, drawn on the server. Null for a widget the loader did not read. */
export function widgetBodies(
  data: FocusedOverviewData,
  linked: boolean,
): Record<OverviewWidgetId, WidgetBody | null> {
  const { metrics, topology, health, attention, root, rangeParam } = data;
  const reload = data.window === 7 ? root : `${root}?range=${rangeParam}`;
  return {
    metrics: metrics && {
      link: { href: `${root}/traces?range=${rangeParam}`, label: "Open Traces" },
      body:
        metrics === "failed" ? (
          <NotLoaded title="These numbers did not load." href={reload} />
        ) : (
          <Metrics data={metrics} />
        ),
    },
    topology: topology && {
      link: linked
        ? { href: agentsHref(data.project.id, { range: rangeParam }), label: "Open Agents" }
        : null,
      body:
        topology === "failed" ? (
          <NotLoaded title="The map did not load." href={reload} />
        ) : (
          <TopologyMap
            projectId={data.project.id}
            graph={topology}
            range={rangeParam}
            linked={linked}
            bare
          />
        ),
    },
    health: health && {
      link: { href: health.href, label: "Open Agent health" },
      body: <HealthWidget health={health} window={data.window} />,
    },
    attention: attention && {
      link: { href: attention.healthHref, label: "Open Agent health" },
      body: <NeedsAttention attention={attention} reload={reload} />,
    },
  };
}

function Metrics({ data }: { data: MetricsData }) {
  const stats = focusedStats(data);
  return (
    <StatRow
      stats={stats}
      // The card is the frame. A change that does not fit beside its number goes under it.
      className="min-h-0 flex-1 overflow-auto rounded-none border-0 border-t lg:[&>div]:p-3 [&_dd]:flex-wrap"
    />
  );
}

function NeedsAttention({ attention, reload }: { attention: FocusedAttention; reload: string }) {
  const { items, moreIssues, healthHref, partial } = attention;
  if (items.length === 0 && partial)
    return <NotLoaded title="Needs attention did not load." href={reload} />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto border-t border-line">
      {items.length === 0 ? (
        <EmptyState
          icon={CircleCheck}
          title="Nothing needs you right now"
          description="Failed runs, issues and fixes show up here."
          className="py-6"
        />
      ) : (
        <AttentionList items={items} bare />
      )}
      {partial ? (
        <p className="border-t border-line px-4 py-2.5 text-xs text-fg-subtle">
          Some checks did not load.
        </p>
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

function NotLoaded({ title, href }: { title: string; href: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto p-4 text-center">
      <p className="text-sm text-danger">{title}</p>
      <Link href={href} className={buttonVariants({ variant: "secondary", size: "sm" })}>
        Try again
      </Link>
    </div>
  );
}
