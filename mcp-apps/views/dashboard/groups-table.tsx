/**
 * A widget with a group-by in a view: a list of its values, the most traces first, with their
 * traces and their numbers in one line. The console draws one small chart per value, which a cell
 * of a view is too small for.
 */
import { DataTable } from "@ratel/design-system/data-table";
import { EmptyState } from "@ratel/design-system/states";
import { Waypoints } from "lucide-react";
import type { GroupedResult } from "@/lib/synthesis/metrics/groups";
import { formatInteger } from "@/lib/synthesis/traces/v2/format";
import { groupByLabel, groupValueLabel, leftOutNote } from "@/lib/views/dashboards/grouped";

/** The result as get_dashboard and query_monitoring give a view: each value with its line. */
export type ViewGroups = GroupedResult & {
  groups: (GroupedResult["groups"][number] & { summary?: string })[];
};

export function GroupsTable({ result }: { result: ViewGroups }) {
  const { by, groups, leftOut } = result;
  if (groups.length === 0)
    return (
      <EmptyState
        icon={Waypoints}
        title="No traces in this time range"
        description="Try a longer range or fewer filters."
      />
    );
  const note = leftOutNote(leftOut);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <DataTable
        caption={`By ${groupByLabel(by)}`}
        density="compact"
        rows={groups}
        rowKey={({ value }) => value ?? ""}
        columns={[
          {
            id: "value",
            header: groupByLabel(by),
            className: "max-w-0 truncate",
            cell: ({ value }) => groupValueLabel(by, value),
          },
          {
            id: "traces",
            header: "Traces",
            align: "right",
            width: "5rem",
            cell: ({ traces }) => formatInteger(traces),
          },
          {
            id: "numbers",
            header: "Numbers",
            className: "max-w-0 truncate",
            cell: ({ summary }) => (
              <span title={summary}>{summary ?? "No numbers were read."}</span>
            ),
          },
        ]}
      />
      {note ? <p className="text-xs text-fg-subtle">{note}</p> : null}
    </div>
  );
}
