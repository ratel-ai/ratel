import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { KeyRound } from "lucide-react";
import Link from "next/link";
import { Trend } from "@/components/console/health/primitives/Sparkline";
import { projectRoot } from "@/lib/console/navigation";
import { byValueDesc, formatMetric } from "@/lib/views/custom-dashboards/present";
import type { WidgetGroup } from "@/lib/views/custom-dashboards/query";
import type { WidgetChart, WidgetMetric } from "@/lib/views/custom-dashboards/spec";
import type { WidgetData } from "@/lib/views/custom-dashboards/widget-data";

/**
 * What a widget draws (RC-888): its number, line, bars or table, or the state
 * that stands in for them (no data, a pivot to set up, a failed query). Group
 * values show as they are stored, so a pivot reads its raw ids.
 */

const LINE_ACCENT = "var(--color-chart-1)";
const BAR_FILL = "var(--color-chart-1)";
const NOT_SET = "Not set";
const OTHER = "Other";

interface Row {
  key: string;
  label: string;
  value: number | null;
  runs: number;
  muted: boolean;
}

export function WidgetBody({
  projectId,
  metric,
  chart,
  data,
}: {
  projectId: string;
  metric: WidgetMetric;
  chart: WidgetChart;
  data: WidgetData;
}) {
  if ("failed" in data) {
    return (
      <Callout tone="danger" title="This widget could not load.">
        Reload the page to try again.
      </Callout>
    );
  }
  const result = data.result;
  switch (result.kind) {
    case "invalid":
      return (
        <Callout tone="warning" title="This widget is no longer valid.">
          Edit it to choose its fields again.
        </Callout>
      );
    case "pivot_missing":
      return (
        <EmptyState
          icon={KeyRound}
          title="Set up a pivot first"
          description={`This widget reads the ${result.pivot.replace(/_/g, " ")} pivot, and the project has none.`}
          action={
            <Link
              className="text-sm text-accent hover:underline"
              href={`${projectRoot(projectId)}/settings/pivots`}
            >
              Open pivot settings
            </Link>
          }
        />
      );
    case "total":
      return <KpiValue metric={metric} value={result.value} runs={result.runs} />;
    case "groups": {
      const rows = toRows(
        chart === "line" ? result.groups : byValueDesc(result.groups),
        result.other,
      );
      if (rows.length === 0)
        return (
          <EmptyState
            title="No runs in this range"
            description="Pick a longer range or a wider filter."
          />
        );
      if (chart === "line") return <DayLine metric={metric} rows={rows} />;
      if (chart === "bar") return <Bars metric={metric} rows={rows} />;
      return <GroupTable metric={metric} rows={rows} />;
    }
  }
}

function KpiValue({
  metric,
  value,
  runs,
}: {
  metric: WidgetMetric;
  value: number | null;
  runs: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xl font-semibold tabular-nums text-fg">
        {formatMetric(metric, value)}
      </span>
      <span className="text-xs text-fg-subtle">
        {runs === 1 ? "1 run" : `${formatMetric("runs", runs)} runs`}
      </span>
    </div>
  );
}

function DayLine({ metric, rows }: { metric: WidgetMetric; rows: Row[] }) {
  const values = rows.map((row) => row.value);
  const measured = values.filter((value): value is number => value !== null);
  const max = Math.max(...measured, 0);
  const last = rows.at(-1);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-2xl font-semibold tabular-nums text-fg">
          {formatMetric(metric, last?.value ?? null)}
        </span>
        <span className="text-xs text-fg-subtle">on {last?.label}</span>
      </div>
      <Trend
        data={values}
        accent={LINE_ACCENT}
        domain={{ min: 0, max: max > 0 ? max : 1 }}
        endDot
        strong
        height={96}
      />
      <div className="flex justify-between text-xs text-fg-subtle tabular-nums">
        <span>{rows[0]?.label}</span>
        <span>{last?.label}</span>
      </div>
    </div>
  );
}

function Bars({ metric, rows }: { metric: WidgetMetric; rows: Row[] }) {
  const max = Math.max(...rows.map((row) => row.value ?? 0), 0);
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Values by group">
      {rows.map((row) => (
        <li
          key={row.key}
          className="grid grid-cols-[minmax(6rem,12rem)_1fr_auto] items-center gap-3 text-sm"
        >
          <span
            className={row.muted ? "truncate text-fg-subtle" : "truncate font-mono text-xs text-fg"}
            title={row.label}
          >
            {row.label}
          </span>
          <span className="h-3 rounded-r-[4px]" aria-hidden>
            <span
              className="block h-3 rounded-r-[4px]"
              style={{
                width: `${max > 0 ? Math.max(1, ((row.value ?? 0) / max) * 100) : 0}%`,
                backgroundColor: BAR_FILL,
                opacity: row.muted ? 0.45 : 1,
              }}
            />
          </span>
          <span className="text-right tabular-nums text-fg-muted">
            {formatMetric(metric, row.value)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function GroupTable({ metric, rows }: { metric: WidgetMetric; rows: Row[] }) {
  const columns: Column<Row>[] = [
    {
      id: "group",
      header: "Group",
      cell: (row) => (
        <span className={row.muted ? "text-fg-subtle" : "font-mono text-xs"}>{row.label}</span>
      ),
    },
    {
      id: "value",
      header: "Value",
      align: "right",
      width: "8rem",
      cell: (row) => formatMetric(metric, row.value),
    },
    {
      id: "runs",
      header: "Runs",
      align: "right",
      width: "6rem",
      cell: (row) => formatMetric("runs", row.runs),
    },
  ];
  return (
    <DataTable
      caption="Values by group"
      columns={columns}
      rows={rows}
      rowKey={(row) => row.key}
      density="compact"
    />
  );
}

function toRows(
  groups: readonly WidgetGroup[],
  other: { value: number | null; runs: number } | null,
): Row[] {
  const rows = groups.map((group) => ({
    key: group.key === null ? "\u0000not-set" : `v:${group.key}`,
    label: group.key ?? NOT_SET,
    value: group.value,
    runs: group.runs,
    muted: group.key === null,
  }));
  if (other)
    rows.push({
      key: "\u0000other",
      label: OTHER,
      value: other.value,
      runs: other.runs,
      muted: true,
    });
  return rows;
}
