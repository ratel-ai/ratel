import { buttonVariants } from "@ratel/design-system/button-variants";
import { StatRow } from "@ratel/design-system/stat-row";
import { EmptyState } from "@ratel/design-system/states";
import { ArrowRight, CircleCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { AttentionList } from "@/components/console/home/AttentionList";
import { HealthWidget } from "@/components/console/home/focused/HealthWidget";
import { focusedStats } from "@/components/console/home/overview-stats";
import { TopologyMap } from "@/components/console/topology/TopologyMap";
import { fmtCount } from "@/lib/platform/format";
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
  const { metrics, topology, health, attention, root, rangeParam } = data;
  const reload = data.window === 7 ? root : `${root}?range=${rangeParam}`;
  return {
    metrics:
      metrics === "failed" ? (
        <NotLoaded title="These numbers did not load." href={reload} />
      ) : (
        metrics && <Metrics data={metrics} peekHref={peekHref} />
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
          />
        )
      ),
    health: health && <HealthWidget health={health} window={data.window} />,
    attention: attention && (
      <NeedsAttention attention={attention} reload={reload} peekHref={peekHref} />
    ),
  };
}

function Metrics({ data, peekHref }: { data: MetricsData; peekHref?: PeekHref }) {
  const stats = focusedStats(data).map(({ peek, ...stat }) =>
    peek && peekHref ? { ...stat, href: peekHref(peek) } : { ...stat, peek },
  );
  return (
    <StatRow
      stats={stats}
      // No frame: only the lines between the numbers. A change that does not fit beside its number goes under it.
      className="min-h-0 flex-1 overflow-auto rounded-none border-0 lg:[&>div]:px-3 lg:[&>div]:py-2.5 [&>div:hover]:bg-app [&>div:hover_dt]:text-fg [&_dd]:flex-wrap"
    />
  );
}

function NeedsAttention({
  attention,
  reload,
  peekHref,
}: {
  attention: FocusedAttention;
  reload: string;
  peekHref?: PeekHref;
}) {
  const { moreIssues, healthHref, partial } = attention;
  const items = attention.items.map((item) =>
    item.target.kind === "peek" && peekHref
      ? { ...item, target: { kind: "link" as const, href: peekHref(item.target.peek) } }
      : item,
  );
  if (items.length === 0 && partial)
    return <NotLoaded title="Needs attention did not load." href={reload} />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {items.length === 0 ? (
        <EmptyState
          icon={CircleCheck}
          title="Nothing needs you right now"
          description="Failed runs, issues and fixes show up here."
          action={
            <Link
              href={healthHref}
              className={buttonVariants({ variant: "secondary", size: "sm" })}
            >
              Open Agent health
            </Link>
          }
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
