import { Badge, StatusDot } from "@ratel/design-system/badge";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { StatRow } from "@ratel/design-system/stat-row";
import { Callout } from "@ratel/design-system/states";
import Link from "next/link";
import type { ReactNode } from "react";
import { AnalysisStatus } from "@/components/console/freshness/AnalysisStatus";
import { formatTimestamp } from "@/lib/synthesis/traces/format";
import type { OverviewData } from "@/lib/views/home/load";
import { OVERVIEW_WINDOWS, overviewRangeParam } from "@/lib/views/home/overview-model";
import { relativeTimeLabel } from "@/lib/views/intents/adaptive-view";
import { AttentionSection } from "./AttentionList";
import { overviewStats } from "./overview-stats";
import { ProductGlance } from "./ProductGlance";
import { RecentRunsSection } from "./RecentRuns";

export { isSdkOnly, overviewStats } from "./overview-stats";

/** Fresh enough to call the connection live. */
const LIVE_MS = 24 * 60 * 60 * 1_000;

/**
 * Overview (DESIGN.md, One question per page): how is this project doing, and
 * what needs me? The numbers with their days, the one product at a glance
 * (intents, tasks, self-corrections, fixes), one short list of what needs a
 * look, and the latest runs to the side. Everything else is a click away.
 */
export function OverviewView({
  data,
  now,
  actions,
  setup,
  contextPanel,
}: {
  data: OverviewData;
  now: Date;
  /** Header actions owned by the page, such as the tour. */
  actions?: ReactNode;
  /** Shown instead of the numbers until the first event arrives. */
  setup: ReactNode;
  /** The `?peek=context` panel, rendered by the page. */
  contextPanel?: ReactNode;
}) {
  const { project, root, hasTelemetry } = data;
  return (
    <Page>
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            {project.name}
            {project.isDemo ? <Badge tone="info">Sample data</Badge> : null}
          </span>
        }
        actions={
          <>
            {hasTelemetry ? <AnalysisStatus projectId={project.id} section="overview" /> : null}
            <TelemetryStatus lastEventAt={data.lastEventAt} now={now} />
            {hasTelemetry ? <WindowSwitch root={root} window={data.window} /> : null}
            {actions}
          </>
        }
      />
      <PageBody>
        {project.isDemo ? <DemoNotice projectId={project.id} projectName={project.name} /> : null}
        {hasTelemetry ? (
          <>
            {data.traces ? (
              <StatRow stats={overviewStats(data, data.traces)} />
            ) : (
              <Callout
                tone="danger"
                title="These numbers did not load"
                action={
                  <Link
                    href={data.rangeParam === "7d" ? root : `${root}?range=${data.rangeParam}`}
                    className={buttonVariants({ variant: "secondary", size: "sm" })}
                  >
                    Try again
                  </Link>
                }
              >
                Reading this window took too long. The rest of the page still works.
              </Callout>
            )}
            <ProductGlance glance={data.glance} />
            <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <AttentionSection attention={data.attention} healthHref={data.health?.href ?? null} />
              <RecentRunsSection data={data} now={now} />
            </div>
          </>
        ) : (
          setup
        )}
      </PageBody>
      {contextPanel}
    </Page>
  );
}

/* - Header ------------------------------------------------------------------- */

export function TelemetryStatus({ lastEventAt, now }: { lastEventAt: Date | null; now: Date }) {
  if (!lastEventAt) return <StatusDot tone="neutral" label="No data yet" />;
  const live = now.getTime() - lastEventAt.getTime() < LIVE_MS;
  return (
    <span title={`Last event ${formatTimestamp(lastEventAt)}`}>
      <StatusDot
        tone={live ? "success" : "neutral"}
        label={live ? "Receiving data" : `Last event ${relativeTimeLabel(lastEventAt, now)}`}
      />
    </span>
  );
}

/** The window as links, so it lives in the URL and survives a reload. */
export function WindowSwitch({ root, window }: { root: string; window: number }) {
  return (
    <nav
      aria-label="Time window"
      className="inline-flex items-center gap-0.5 rounded-md border border-line bg-app p-0.5"
    >
      {OVERVIEW_WINDOWS.map((option) => {
        const active = option === window;
        return (
          <Link
            key={option}
            href={option === 7 ? root : `${root}?range=${overviewRangeParam(option)}`}
            aria-current={active ? "true" : undefined}
            className={cn(
              "inline-flex h-6 items-center rounded-[4px] px-2 text-ui font-medium outline-none transition-colors duration-120 focus-visible:ring-2 focus-visible:ring-focus",
              active ? "bg-selected text-fg" : "text-fg-muted hover:text-fg",
            )}
          >
            {option} days
          </Link>
        );
      })}
    </nav>
  );
}

function DemoNotice({ projectId, projectName }: { projectId: string; projectName: string }) {
  return (
    <div data-tour="demo-notice">
      <Callout
        title={`${projectName} is sample data`}
        action={
          <Link href="/onboarding" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            Create your own project
          </Link>
        }
      >
        Every run, cost and fix here is made up.{" "}
        <Link
          href={`/project/${encodeURIComponent(projectId)}/settings/danger`}
          className="text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg-muted"
        >
          Delete it
        </Link>{" "}
        when you are done.
      </Callout>
    </div>
  );
}
