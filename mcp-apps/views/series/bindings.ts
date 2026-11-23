import type { McpAppBinding } from "@/lib/mcp/apps/types";
import type { SeriesConfig } from "../../shell/config";
import type { ViewBindings } from "../../shell/types";

export type SeriesBinding = McpAppBinding & { config: SeriesConfig };

/** A measure over time: its key numbers, then one chart. */
export const seriesBindings: SeriesBinding[] = [
  {
    tool: "get_cost_by_day",
    config: {
      rows: "series",
      x: "day",
      measure: { key: "costUsd", label: "Cost", format: "currency" },
      stats: [
        { label: "Cost", key: "costUsd", aggregate: "sum", format: "currency" },
        { label: "Runs", key: "runs", aggregate: "sum", format: "number" },
        { label: "Output tokens", key: "outputTokens", aggregate: "sum", format: "number" },
        { label: "Busiest day", key: "costUsd", aggregate: "max", format: "currency" },
      ],
    },
  },
  {
    // Runs per day, as the Traces volume chart; the headline numbers are the
    // tool's own window figures, so they show even without includeDaily.
    tool: "get_trace_health",
    config: {
      rows: "daily",
      x: "day",
      measure: { key: "traceCount", label: "Runs", format: "number" },
      stats: [
        { label: "Runs", key: "kpis.traceCount", aggregate: "window", format: "number" },
        { label: "Error rate", key: "kpis.errorRate", aggregate: "window", format: "percent" },
        { label: "p50 latency", key: "kpis.p50LatencyMs", aggregate: "window", format: "duration" },
        { label: "p95 latency", key: "kpis.p95LatencyMs", aggregate: "window", format: "duration" },
        { label: "Cost", key: "kpis.costUsd", aggregate: "window", format: "currency" },
      ],
      empty: {
        title: "No per-day series",
        description:
          "The numbers above cover the whole window. Ask again with includeDaily for runs per day.",
      },
    },
  },
];

const view: ViewBindings<SeriesBinding> = {
  title: "Series",
  description: "A Ratel measure over time: key numbers and one chart, with the table a click away.",
  bindings: seriesBindings,
};

export default view;
