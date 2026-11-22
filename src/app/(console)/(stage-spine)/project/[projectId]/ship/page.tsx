import { buttonVariants } from "@ratel/design-system/button-variants";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { Rocket } from "lucide-react";
import Link from "next/link";
import { shipmentCommitsFor } from "@/components/console/code-handoff/deploy/opened-shipment-commits";
import { type OpenedShipment, ShipmentsTable } from "@/components/console/lineage/ShipmentsTable";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { ShipmentWatchList } from "@/components/console/ship-monitor/ShipmentWatchCard";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { evalGateEnabledFor } from "@/lib/views/eval-gate/gate";
import { fixHref } from "@/lib/views/fixes/href";
import { lineageShowsTraces } from "@/lib/views/lineage/plan";
import { loadShipments, type ShipmentRow } from "@/lib/views/lineage/shipments";
import { shipmentTrail } from "@/lib/views/lineage/trail";
import type { LineageRef } from "@/lib/views/lineage/types";
import { shipMonitorEnabledFor } from "@/lib/views/ship-monitor/gate";
import { loadShipmentWatches } from "@/lib/views/ship-monitor/load";
import type { ShipmentWatch } from "@/lib/views/ship-monitor/watch";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ship" };

/**
 * Ship, the fourth stage (RC-45): what went live,
 * each with the fix it came from. Today that is applied description rewrites
 * and shipments recorded through lineage; RC-53 brings releases. With
 * `FF_SHIP_MONITOR` on, the newest shipped fixes are watched live above the
 * list, and the Panel watches the opened one. Owned (ADR-0030): the
 * project comes from the console scope, and the eval gate is read from the environment.
 */
export default async function ShipPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Ship">
        Shipped changes appear once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const { projectId } = await params;
  const { project, organization } = await requireProjectScope(projectId);
  const distinctId = `project:${project.id}`;
  const rawPeek = (await searchParams).peek;
  const peek = typeof rawPeek === "string" && rawPeek.length > 0 ? rawPeek : null;

  const shipments = await loadOrFallback<ShipmentRow[] | null>({
    operation: "ship_shipments",
    distinctId,
    fallback: null,
    load: () =>
      withStatementTimeout((db) => loadShipments(project.id, db), { operation: "ship_shipments" }),
  });
  // The opened shipment (`?peek=`, a row click or a link): its trail back to the run it started from (RC-71).
  const opened = peek ? (shipments?.find((row) => row.ref.id === peek) ?? null) : null;
  const trail: OpenedShipment | null = opened
    ? {
        id: opened.ref.id,
        trail: await loadOrFallback<LineageRef[]>({
          operation: "ship_lineage_chain",
          distinctId,
          fallback: opened.source ? [opened.source, opened.ref] : [opened.ref],
          load: async () => {
            const evals = await evalGateEnabledFor(organization).catch(() => false);
            return withStatementTimeout(
              (db) =>
                shipmentTrail(
                  opened.ref,
                  {
                    projectId: project.id,
                    traces: lineageShowsTraces(organization),
                    evals,
                    db,
                  },
                  opened.source,
                ),
              { operation: "ship_lineage_chain" },
            );
          },
        }),
        commits: await shipmentCommitsFor(organization, project.id, opened.ref.id),
      }
    : null;
  const fixes = fixHref(project.id);
  const watching =
    shipments !== null && (await shipMonitorEnabledFor(organization).catch(() => false));
  const watches = watching
    ? await loadOrFallback<ShipmentWatch[]>({
        operation: "ship_watch",
        distinctId,
        fallback: [],
        load: () =>
          withStatementTimeout((db) => loadShipmentWatches(project.id, { now: new Date() }, db), {
            operation: "ship_watch",
          }),
      })
    : [];

  return (
    <Page>
      <PageHeader title="Ship" description="What went live, and the fix each change came from." />
      <PageBody>
        {watching ? (
          <Section
            title="Watching live"
            description="How each newly shipped fix behaves in live traffic, beside the 7 days before it shipped."
          >
            <ShipmentWatchList projectId={project.id} initial={watches} />
          </Section>
        ) : null}
        {shipments === null ? (
          <Callout
            tone="danger"
            title="Shipped changes did not load"
            action={
              <Link
                href={`/project/${encodeURIComponent(project.id)}/ship`}
                className={buttonVariants({ variant: "secondary", size: "sm" })}
              >
                Try again
              </Link>
            }
          >
            Reading them took too long. The rest of the console still works.
          </Callout>
        ) : shipments.length === 0 ? (
          <EmptyState
            icon={Rocket}
            title="Nothing shipped yet"
            description="A fix you apply or mark as shipped shows up here, linked to the fix it came from."
            action={
              <Link href={fixes} className={buttonVariants({ variant: "primary" })}>
                Open fixes
              </Link>
            }
          />
        ) : (
          <Section
            title={`${shipments.length} shipped ${shipments.length === 1 ? "change" : "changes"}`}
          >
            <ShipmentsTable
              projectId={project.id}
              rows={shipments}
              now={new Date().toISOString()}
              opened={trail}
              watch={watching}
            />
          </Section>
        )}
      </PageBody>
    </Page>
  );
}
