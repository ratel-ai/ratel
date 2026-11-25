import { Badge, StatusDot } from "@ratel/design-system/badge";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Callout } from "@ratel/design-system/states";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  AddWidgetDialog,
  EditBar,
  EditButton,
  HeaderInEditMode,
} from "@/components/console/home/focused/EditMode";
import { HistoryDialog } from "@/components/console/home/focused/HistoryDialog";
import { OverviewGrid } from "@/components/console/home/focused/OverviewGrid";
import {
  type LayoutActions,
  OverviewLayoutProvider,
} from "@/components/console/home/focused/OverviewLayout";
import { widgetBodies } from "@/components/console/home/focused/widget-bodies";
import { formatTimestamp } from "@/lib/synthesis/traces/format";
import type { FocusedOverviewData } from "@/lib/views/home/focused-load";
import { OVERVIEW_WINDOWS, overviewRangeParam } from "@/lib/views/home/overview-model";
import { relativeTimeLabel } from "@/lib/views/intents/adaptive-view";
import type { LayoutSnapshot } from "@/lib/views/overview-layout/actions";

/** Fresh enough to call the connection live. */
const LIVE_MS = 24 * 60 * 60 * 1_000;

/** The recap Overview: the widgets a person chose, where they put them. Everything else is a click away. */
export function FocusedOverviewView({
  data,
  now,
  linked,
  saved,
  layoutActions,
  startEditing,
  actions,
  setup,
  contextPanel,
}: {
  data: FocusedOverviewData;
  now: Date;
  /** The Agents and MCP servers pages exist. */
  linked: boolean;
  /** The state that `data.layout` is of. */
  saved: Pick<LayoutSnapshot, "revision" | "undo">;
  /** Changes the layout; null where nobody may. */
  layoutActions: LayoutActions | null;
  /** Draws edit mode at first, in a test. */
  startEditing?: boolean;
  /** Header actions owned by the page, such as the tour. */
  actions?: ReactNode;
  /** Shown instead of the cards until the first event arrives. */
  setup: ReactNode;
  /** The `?peek=context` panel, rendered by the page. */
  contextPanel?: ReactNode;
}) {
  const { project, root, hasTelemetry } = data;
  return (
    <OverviewLayoutProvider
      initial={{ layout: data.layout, ...saved }}
      actions={hasTelemetry ? layoutActions : null}
      startEditing={startEditing}
    >
      <Page>
        <EditBar />
        <HeaderInEditMode>
          <PageHeader
            title={
              <span className="inline-flex items-center gap-2">
                {project.name}
                {project.isDemo ? <Badge tone="info">Sample data</Badge> : null}
              </span>
            }
            actions={
              <>
                {data.telemetryRead || data.lastEventAt ? (
                  <TelemetryStatus lastEventAt={data.lastEventAt} now={now} />
                ) : null}
                {hasTelemetry ? <WindowSwitch root={root} window={data.window} /> : null}
                <EditButton />
                {actions}
              </>
            }
          />
        </HeaderInEditMode>
        <PageBody>
          {project.isDemo ? <DemoNotice projectId={project.id} projectName={project.name} /> : null}
          {hasTelemetry ? <OverviewGrid bodies={widgetBodies(data, linked)} /> : setup}
        </PageBody>
        {contextPanel}
        <AddWidgetDialog />
        <HistoryDialog />
      </Page>
    </OverviewLayoutProvider>
  );
}

/* - Header ------------------------------------------------------------------- */

function TelemetryStatus({ lastEventAt, now }: { lastEventAt: Date | null; now: Date }) {
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
function WindowSwitch({ root, window }: { root: string; window: number }) {
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
