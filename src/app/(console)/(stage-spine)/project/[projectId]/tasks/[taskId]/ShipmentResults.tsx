"use client";

import { type Column, DataTable } from "@ratel/design-system/data-table";
import Link from "next/link";
import type { Tally } from "@/lib/views/eval-gate/types";
import type { taskShipmentsFor } from "@/lib/views/task-evals/post-ship";
import { SCORER_LABELS } from "@/lib/views/task-scorers/labels";
import { SCORER_KINDS } from "@/lib/views/task-scorers/types";

export type TaskShipment = Awaited<ReturnType<typeof taskShipmentsFor>>[number];
type ComparisonRow = {
  id: string;
  label: string;
  baseline: Tally | null;
  predicted: Tally | null;
  actual: Tally;
};

export function ShipmentResults({
  shipments,
  projectId,
  taskId,
}: {
  shipments: readonly TaskShipment[];
  projectId: string;
  taskId: string;
}) {
  const columns: Column<ComparisonRow>[] = [
    { id: "scorer", header: "Scorer", cell: (row) => row.label },
    { id: "baseline", header: "Eval baseline", align: "right", cell: (row) => rate(row.baseline) },
    {
      id: "predicted",
      header: "Predicted after",
      align: "right",
      cell: (row) => rate(row.predicted),
    },
    { id: "actual", header: "Live result", align: "right", cell: (row) => rate(row.actual) },
  ];
  return (
    <div className="flex flex-col gap-4">
      {shipments.map((shipment) => {
        const rows: ComparisonRow[] = SCORER_KINDS.flatMap((kind) =>
          shipment.comparison?.[kind]
            ? [{ id: kind, label: SCORER_LABELS[kind], ...shipment.comparison[kind]! }]
            : [],
        );
        return (
          <div key={shipment.id} className="rounded-lg border border-line p-4">
            <p className="text-ui text-fg">
              <Link
                className="hover:underline"
                href={`/project/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/simulations/${encodeURIComponent(shipment.fixId)}`}
              >
                Live in {shipment.version}
              </Link>
              <span className="ml-3 text-xs text-fg-subtle">
                <time dateTime={shipment.shippedAt}>
                  {new Date(shipment.shippedAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC
                </time>
              </span>
            </p>
            {shipment.notes ? <p className="mt-1 text-ui text-fg-muted">{shipment.notes}</p> : null}
            {shipment.status === "completed" ? (
              <>
                <p className="my-2 text-xs text-fg-subtle">
                  Measured on {shipment.nRuns} completed runs.
                </p>
                <DataTable
                  caption={`Live results for ${shipment.version}`}
                  columns={columns}
                  rows={rows}
                  rowKey={(row) => row.id}
                />
              </>
            ) : (
              <p className="mt-2 text-ui text-fg-muted">
                {shipment.status === "failed"
                  ? (shipment.error ?? "The measurement failed.")
                  : "Waiting for 20 completed runs or 7 days."}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function rate(tally: Tally | null) {
  return tally?.passRate != null
    ? `${Math.round(tally.passRate * 100)}% (${tally.passed}/${tally.total})`
    : "Not measured";
}
