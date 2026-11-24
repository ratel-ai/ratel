import { Badge } from "@ratel/design-system/badge";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { Callout } from "@ratel/design-system/states";
import Link from "next/link";
import type { ReactNode } from "react";
import { HealthCard } from "@/components/console/home/focused/HealthCard";
import { DemoNotice, TelemetryStatus, WindowSwitch } from "@/components/console/home/OverviewView";
import { TopologyMap } from "@/components/console/topology/TopologyMap";
import type { FocusedOverviewData } from "@/lib/views/home/focused-load";

/** The recap Overview: how healthy the project is, and what runs in it. Everything else is a click away. */
export function FocusedOverviewView({
  data,
  now,
  linked,
  actions,
  setup,
  contextPanel,
}: {
  data: FocusedOverviewData;
  now: Date;
  /** The Agents and MCP servers pages exist. */
  linked: boolean;
  /** Header actions owned by the page, such as the tour. */
  actions?: ReactNode;
  /** Shown instead of the cards until the first event arrives. */
  setup: ReactNode;
  /** The `?peek=context` panel, rendered by the page. */
  contextPanel?: ReactNode;
}) {
  const { project, root, hasTelemetry, topology } = data;
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
            {data.telemetryRead || data.lastEventAt ? (
              <TelemetryStatus lastEventAt={data.lastEventAt} now={now} />
            ) : null}
            {hasTelemetry ? <WindowSwitch root={root} window={data.window} /> : null}
            {actions}
          </>
        }
      />
      <PageBody>
        {project.isDemo ? <DemoNotice projectId={project.id} projectName={project.name} /> : null}
        {hasTelemetry ? (
          <div className="flex flex-col gap-8">
            {data.health ? <HealthCard health={data.health} window={data.window} /> : null}
            <Section title="Agents and MCP servers" className="min-w-0">
              {topology && topology !== "failed" ? (
                <TopologyMap
                  projectId={project.id}
                  graph={topology}
                  range={data.rangeParam}
                  linked={linked}
                />
              ) : (
                <Callout
                  tone="danger"
                  title="The map did not load"
                  action={
                    <Link
                      href={data.window === 7 ? root : `${root}?range=${data.rangeParam}`}
                      className={buttonVariants({ variant: "secondary", size: "sm" })}
                    >
                      Try again
                    </Link>
                  }
                >
                  Reading this window took too long. The rest of the page still works.
                </Callout>
              )}
            </Section>
          </div>
        ) : (
          setup
        )}
      </PageBody>
      {contextPanel}
    </Page>
  );
}
