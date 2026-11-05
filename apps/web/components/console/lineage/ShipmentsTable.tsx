"use client";

import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Panel, usePeek } from "@ratel/design-system/panel";
import { stepIndex, withPeek } from "@ratel/design-system/peek";
import { Skeleton } from "@ratel/design-system/states";
import { Tooltip } from "@ratel/design-system/tooltip";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { formatStamp, relativeTime } from "@/lib/console/settings/format";
import type { ShipmentRow } from "@/lib/views/lineage/shipments";
import type { LineageRef } from "@/lib/views/lineage/types";
import { LineageSteps, SourceLink } from "./SourceLink";

/** The opened shipment's trail, read on the server for `?peek=<id>` (`shipmentTrail`). */
export interface OpenedShipment {
  id: string;
  trail: readonly LineageRef[];
}

/**
 * Ship's list: what went live, when, and the fix it came from. Clicking a row
 * (or Enter on it) opens its Panel with the trail back to the run it started
 * from (RC-71). The open row lives in the URL (`?peek=<shipment id>`); the
 * trail is read on the server for it, so opening one is a navigation: the
 * Panel opens at once on the clicked row and holds a skeleton until it lands.
 */
export function ShipmentsTable({
  projectId,
  rows,
  now,
  opened = null,
}: {
  projectId: string;
  rows: readonly ShipmentRow[];
  now: string;
  opened?: OpenedShipment | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const peek = usePeek();
  const [pending, startTransition] = useTransition();
  const [lastId, setLastId] = useState<string | null>(null);
  const at = new Date(now);

  const clicked = lastId ? (rows.find((row) => row.ref.id === lastId) ?? null) : null;
  // While a click navigates, the clicked row is the open one, so the Panel answers before the server does.
  const current =
    pending && clicked
      ? clicked
      : peek.id
        ? (rows.find((row) => row.ref.id === peek.id) ?? null)
        : null;
  // Kept while the Panel closes, so it does not blank on its way out.
  const showing = current ?? clicked;
  const trail = showing && opened?.id === showing.ref.id ? opened.trail : null;

  const openRow = (id: string) => {
    setLastId(id);
    // A navigation, not a History API rewrite: the trail is read on the server.
    startTransition(() =>
      router.replace(`${pathname}${withPeek(searchParams.toString(), id)}`, { scroll: false }),
    );
  };
  const step = (direction: 1 | -1) => {
    const index = current ? rows.findIndex((row) => row.ref.id === current.ref.id) : -1;
    const next = rows[stepIndex(index, direction, rows.length)];
    if (next) openRow(next.ref.id);
  };

  const columns: Column<ShipmentRow>[] = [
    {
      id: "change",
      header: "Change",
      cell: (row) => <span className="text-ui text-fg">{row.title}</span>,
    },
    {
      id: "from",
      header: "From",
      width: "40%",
      hiddenBelow: "md",
      cell: (row) => (
        <SourceLink
          source={row.source}
          projectId={projectId}
          empty="No fix recorded"
          className="[&>span:first-child]:sr-only"
        />
      ),
    },
    {
      id: "shipped",
      header: "Shipped",
      align: "right",
      width: "8rem",
      cell: (row) => (
        <Tooltip content={new Date(row.shippedAt).toLocaleString()}>
          <span className="text-ui text-fg-muted tabular-nums">
            {relativeTime(row.shippedAt, at)}
          </span>
        </Tooltip>
      ),
    },
  ];
  return (
    <>
      <DataTable
        caption="Shipped changes"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.ref.id}
        selectedKey={current?.ref.id ?? null}
        onRowOpen={(row) => openRow(row.ref.id)}
      />
      <Panel
        open={current !== null}
        onOpenChange={(next) => {
          if (!next) peek.close();
        }}
        title={showing?.title ?? ""}
        subtitle={showing ? `Shipped ${formatStamp(showing.shippedAt)}` : undefined}
        onPrevious={() => step(-1)}
        onNext={() => step(1)}
      >
        {showing ? (
          <section
            aria-label="Its trail"
            className="flex flex-col gap-3"
            data-shipment-trail={showing.ref.id}
          >
            <h3 className="text-xs font-medium text-fg-subtle">Where it came from</h3>
            {trail ? <ShipmentTrail trail={trail} projectId={projectId} /> : <TrailSkeleton />}
          </section>
        ) : null}
      </Panel>
    </>
  );
}

/** The trail, or what to say when the shipment names nothing before itself. */
export function ShipmentTrail({
  trail,
  projectId,
}: {
  trail: readonly LineageRef[];
  projectId: string;
}) {
  if (trail.length < 2) {
    return (
      <>
        <LineageSteps chain={trail} projectId={projectId} />
        <p className="text-xs text-fg-subtle">
          No fix was recorded for this change, so its trail starts here.
        </p>
      </>
    );
  }
  return <LineageSteps chain={trail} projectId={projectId} />;
}

/** Four steps, the usual trail's height: trace, insight, fix, shipment. */
function TrailSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading its trail" className="flex flex-col gap-3">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="size-2 rounded-full" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-6 w-48" />
        </div>
      ))}
    </div>
  );
}
