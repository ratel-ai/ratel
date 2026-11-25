import { Badge } from "@ratel/design-system/badge";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import type { ReactNode } from "react";
import {
  AddWidgetDialog,
  EditBar,
  EditButton,
  HeaderInEditMode,
} from "@/components/console/home/focused/EditMode";
import { OverviewGrid } from "@/components/console/home/focused/OverviewGrid";
import {
  type LayoutActions,
  OverviewLayoutProvider,
} from "@/components/console/home/focused/OverviewLayout";
import { widgetBodies } from "@/components/console/home/focused/widget-bodies";
import { DemoNotice, TelemetryStatus, WindowSwitch } from "@/components/console/home/OverviewView";
import type { FocusedOverviewData } from "@/lib/views/home/focused-load";
import type { LayoutSnapshot } from "@/lib/views/overview-layout/actions";

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
      </Page>
    </OverviewLayoutProvider>
  );
}
