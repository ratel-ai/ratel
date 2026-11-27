/**
 * The clusters widget in a view: a table. The console draws the Intents map's own zoomable drawings,
 * which bring about 150 KB and the map's reads with them.
 */
import { DataTable } from "@ratel/design-system/data-table";
import { EmptyState } from "@ratel/design-system/states";
import { Orbit } from "lucide-react";
import { formatInteger } from "@/lib/synthesis/traces/v2/format";
import type { DashboardClusters } from "@/lib/views/dashboards/clusters";
import { intentsMapHref } from "@/lib/views/dashboards/links";
import Link from "../../shell/shims/next-link";

export function ClustersTable({
  projectId,
  result: { view, model, analyzedAt },
}: {
  projectId: string;
  result: DashboardClusters;
}) {
  if (!analyzedAt)
    return (
      <EmptyState
        icon={Orbit}
        title="No intent analysis yet"
        description="The clusters appear after the first analysis of the project's asks."
      />
    );
  const rows =
    view === "asks"
      ? model.asks.map(({ id, label, volume }) => ({ id, name: label, count: volume }))
      : model.capabilities.map(({ id, name, calls }) => ({ id, name, count: calls }));
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <DataTable
        caption={view === "asks" ? "Intent clusters" : "Tools of the intent clusters"}
        density="compact"
        rows={rows}
        rowKey={({ id }) => id}
        columns={[
          { id: "name", header: view === "asks" ? "Cluster" : "Tool", cell: ({ name }) => name },
          {
            id: "count",
            header: view === "asks" ? "Asks" : "Calls",
            align: "right",
            width: "6rem",
            cell: ({ count }) => formatInteger(count),
          },
        ]}
      />
      <p className="text-xs text-fg-subtle">
        Analysis of {analyzedAt.slice(0, 10)}. The time range and the filters do not change it.{" "}
        <Link href={intentsMapHref(projectId)} className="text-fg-muted underline hover:text-fg">
          Open Intents
        </Link>
      </p>
    </div>
  );
}
