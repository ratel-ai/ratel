import { cn } from "@ratel/design-system/cn";
import { DataTable } from "@ratel/design-system/data-table";
import { StatRow } from "@ratel/design-system/stat-row";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { useMemo, useState } from "react";
import { niceTicks } from "@/lib/platform/chart";
import { formatDay } from "@/lib/synthesis/traces/v2/format";
import { useRatelView } from "../../shell/bridge";
import { getPath, parseSeriesConfig, type SeriesConfig } from "../../shell/config";
import { tableColumns } from "../../shell/detail-body";
import { aggregate, formatValue } from "../../shell/format";
import { mountView } from "../../shell/mount";
import type { ToolSuccess } from "../../shell/state";
import { ViewFrame } from "../../shell/view-frame";
import view, { type SeriesBinding } from "./bindings";

type Row = Record<string, unknown>;

const HEIGHT = 160;
const AXIS = 22;
const GAP = 2;

/** The tool's own figure for the window; null (no latency without traces) stays "–", never 0. */
function windowValue(value: unknown): number | null {
  return value === null || value === undefined ? null : aggregate([value], "last");
}

function label(x: unknown): string {
  const text = String(x ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? formatDay(text) : text;
}

/**
 * One measure as bars over time, in the Traces volume chart's style
 * (components/traces/v2/VolumeChart.tsx, DESIGN.md Data visualization): neutral
 * fg-faint bars, since one measure carries no category for a color to name;
 * the bar under the pointer or focus lifts to fg-muted and the rest dim. 4 px
 * rounded data ends, 2 px gaps, a recessive grid in line and fg-subtle, and a
 * per-bar readout.
 */
function Bars({ rows, config }: { rows: Row[]; config: SeriesConfig }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = rows.map((row) => Number(getPath(row, config.measure.key)) || 0);
  const max = Math.max(0, ...values);
  const ticks = niceTicks(max > 0 ? max : 1, 3);
  const top = ticks[ticks.length - 1] || 1;
  const width = 100 / Math.max(1, rows.length);
  const every = Math.max(1, Math.ceil(rows.length / 7));
  const focused = hover !== null ? rows[hover] : null;
  const total = values.reduce((sum, value) => sum + value, 0);

  return (
    <figure className="m-0 flex flex-col gap-2">
      <ul
        aria-label="Legend"
        className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted"
      >
        <li className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-[2px] bg-fg-faint" />
          {config.measure.label}
          <span className="text-fg tabular-nums">
            {formatValue(total, config.measure.format, "stat")}
          </span>
        </li>
      </ul>
      <div
        className="relative"
        style={{ height: HEIGHT + AXIS }}
        onPointerLeave={() => setHover(null)}
      >
        <svg
          className="absolute inset-x-0 top-0 block overflow-visible"
          width="100%"
          height={HEIGHT}
          aria-hidden
        >
          {ticks.map((tick) => {
            const y = HEIGHT - (tick / top) * HEIGHT;
            return (
              <line
                key={tick}
                x1="0"
                x2="100%"
                y1={y + 0.5}
                y2={y + 0.5}
                stroke="var(--ds-line)"
                strokeWidth={1}
              />
            );
          })}
        </svg>
        <div className="absolute inset-x-0 top-0 flex items-end" style={{ height: HEIGHT }}>
          {rows.map((row, index) => {
            const share = values[index] / top;
            return (
              <button
                key={String(getPath(row, config.x)) + index}
                type="button"
                aria-label={`${label(getPath(row, config.x))}: ${formatValue(values[index], config.measure.format)}`}
                className="group flex h-full shrink-0 items-end outline-none"
                style={{ width: `${width}%`, paddingLeft: GAP / 2, paddingRight: GAP / 2 }}
                onPointerEnter={() => setHover(index)}
                onFocus={() => setHover(index)}
              >
                <span
                  className={cn(
                    "block w-full rounded-t-[4px] transition-[opacity,background-color] duration-120 group-focus-visible:ring-2 group-focus-visible:ring-focus",
                    hover === index ? "bg-fg-muted" : "bg-fg-faint",
                    hover !== null && hover !== index && "opacity-35",
                  )}
                  style={{ height: `${Math.max(values[index] > 0 ? 2 : 0, share * HEIGHT)}px` }}
                />
              </button>
            );
          })}
        </div>
        <span
          aria-hidden
          className="pointer-events-none absolute top-0 left-0 -translate-y-1/2 bg-app pr-1 text-xs text-fg-subtle tabular-nums"
        >
          {formatValue(top, config.measure.format, "stat")}
        </span>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 h-4 text-xs text-fg-subtle"
          style={{ top: HEIGHT + 6 }}
        >
          {rows.map((row, index) =>
            index % every === 0 ? (
              // Centred on its bar, not boxed to the bar's width: a dense series has bars narrower than a date.
              <span
                key={index}
                className="absolute whitespace-nowrap"
                style={{
                  left: `${(index + 0.5) * width}%`,
                  transform: index === 0 ? "translateX(-0.25rem)" : "translateX(-50%)",
                }}
              >
                {label(getPath(row, config.x))}
              </span>
            ) : null,
          )}
        </div>
        {focused ? (
          <div
            className="pointer-events-none absolute top-1 z-sticky rounded-lg border border-line bg-overlay px-2.5 py-2 text-xs whitespace-nowrap shadow-overlay"
            style={{
              left: `clamp(0px, calc(${(hover! + 0.5) * width}% - 4rem), calc(100% - 8rem))`,
            }}
          >
            <p className="text-fg-subtle">{label(getPath(focused, config.x))}</p>
            <p className="mt-1 flex items-center gap-2">
              <span aria-hidden className="h-0.5 w-3 rounded-full bg-fg-faint" />
              <span className="font-semibold text-fg tabular-nums">
                {formatValue(values[hover!], config.measure.format, "detail")}
              </span>
              <span className="text-fg-muted">{config.measure.label}</span>
            </p>
          </div>
        ) : null}
      </div>
      <figcaption className="sr-only">
        {config.measure.label} per day, {rows.length} days. Switch to the table for every value.
      </figcaption>
    </figure>
  );
}

function Series({ result }: { result: ToolSuccess }) {
  const ratel = useRatelView<unknown, SeriesBinding>();
  const binding = ratel.binding;
  const config = useMemo(
    () => (binding ? parseSeriesConfig(binding.tool, binding.config) : null),
    [binding],
  );
  const [mode, setMode] = useState<"chart" | "table">("chart");
  if (!config)
    return (
      <Callout tone="warning" title="No binding">
        This view does not know how to show {ratel.state.toolName ?? "this tool"}.
      </Callout>
    );

  const rows = (getPath(result.data, config.rows) as Row[] | undefined) ?? [];
  const stats = config.stats.map((stat) => {
    const value =
      stat.aggregate === "window"
        ? windowValue(getPath(result.data, stat.key))
        : aggregate(
            rows.map((row) => getPath(row, stat.key)),
            stat.aggregate,
          );
    return {
      label: stat.label,
      value: value === null ? "–" : formatValue(value, stat.format, "stat"),
    };
  });

  return (
    <div className="flex flex-col gap-4">
      <StatRow stats={stats} />
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-fg">{config.measure.label} per day</h2>
          <SegmentedControl
            label="Show as"
            value={mode}
            onValueChange={setMode}
            options={[
              { value: "chart", label: "Chart" },
              { value: "table", label: "Table" },
            ]}
          />
        </div>
        {rows.length === 0 ? (
          <EmptyState
            emblem
            title={config.empty?.title ?? "No data in this window"}
            description={
              config.empty?.description ??
              "Widen the window, or check back once your agent has sent traffic."
            }
          />
        ) : mode === "chart" ? (
          <Bars rows={rows} config={config} />
        ) : (
          <DataTable
            caption={`${config.measure.label} per day`}
            density="compact"
            columns={tableColumns<Row>(
              [
                { key: config.x, label: "Day", format: "date" },
                config.measure,
                ...config.stats
                  .filter((stat) => stat.key !== config.measure.key && stat.aggregate === "sum")
                  .map((stat) => ({ key: stat.key, label: stat.label, format: stat.format })),
              ],
              rows,
              false,
            )}
            rows={[...rows].reverse()}
            rowKey={(row) => String(getPath(row, config.x))}
          />
        )}
      </section>
    </div>
  );
}

function SeriesView() {
  return <ViewFrame>{(result) => <Series result={result} />}</ViewFrame>;
}

mountView({ name: "series", bindings: view.bindings }, <SeriesView />);
