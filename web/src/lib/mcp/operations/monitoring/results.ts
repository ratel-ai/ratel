import type { Query } from "@/lib/contracts/query";
import { placeName } from "@/lib/ingest/geo/codes";
import { capRows, round, type TruncationTracker } from "@/lib/mcp/serialize";
import { getMetric, type MetricUnit } from "@/lib/synthesis/metrics/catalog";
import type { QueryResult, SqlResult } from "@/lib/synthesis/metrics/query";
import { formatMetric } from "@/lib/views/dashboards/chart-model";
import type { DashboardClusters } from "@/lib/views/dashboards/clusters";
import { measuresOne } from "@/lib/views/dashboards/widget";

/** A query's numbers as a tool returns them: capped, and in one line. */

/** A series keeps its newest points. */
export const POINT_CAP = 120;

function queryUnit(query: Query): MetricUnit | null {
  return measuresOne(query) ? (getMetric(query.measures[0].measure)?.unit ?? null) : null;
}

/** The result for a context window: `limit` rows, and the newest points of a series. */
export function cappedResult(
  query: Query,
  result: QueryResult,
  limit: number,
  tracker: TruncationTracker,
) {
  switch (result.kind) {
    case "metric": {
      const from = Math.max(0, result.buckets.length - POINT_CAP);
      tracker.mark(from > 0);
      return {
        kind: result.kind,
        unit: queryUnit(query),
        bucket: result.bucket,
        buckets: result.buckets.slice(from),
        series: tracker.take(capRows(result.series, limit)).map((series) => ({
          groups: series.groups.map(({ value, label }) => label ?? value),
          total: round(series.total),
          samples: series.samples,
          values: series.values.slice(from).map((value) => round(value)),
        })),
      };
    }
    case "flow":
      tracker.mark(result.moreEdges > 0);
      return { ...result, edges: tracker.take(capRows(result.edges, limit)) };
    case "step_flow": {
      // The names and the paths are what the web app unfolds: here the columns say it.
      const { names: _, paths: __, columns, links, ...rest } = result;
      return {
        ...rest,
        columns: columns.map(({ nodes, ...column }) => ({
          ...column,
          nodes: tracker.take(capRows(nodes, limit)).map(({ name, share, ...node }) => ({
            ...node,
            name: tracker.text(name, 200),
            share: round(share),
          })),
        })),
        links: tracker.take(capRows(links, limit)),
      };
    }
    case "funnel":
      return {
        ...result,
        steps: result.steps.map((step) => ({ ...step, conversion: round(step.conversion) })),
      };
    case "geography":
      return {
        ...result,
        unit: queryUnit(query),
        places: tracker.take(capRows(result.places, limit)).map((place) => ({
          ...place,
          name: placeName(place.code),
          value: round(place.value),
        })),
      };
    case "clusters": {
      const { view, model, analyzedAt, steps } = result as DashboardClusters;
      return {
        kind: result.kind,
        view,
        analyzedAt,
        clusters: tracker.take(capRows(model.asks, limit)).map(({ label, volume, problem }) => ({
          name: tracker.text(label, 200),
          asks: volume,
          problem: problem?.kind ?? null,
        })),
        tools: tracker
          .take(capRows(model.capabilities, limit))
          .map(({ name, kind, calls, missing }) => ({ name, kind, calls, missing })),
        ...(view === "tools" ? { steps: tracker.take(capRows(steps, limit)) } : {}),
      };
    }
    case "sql":
      tracker.mark(result.truncated);
      return { ...result, rows: tracker.take(capRows(result.rows, limit)) };
  }
}

/** The numbers in one line, for a host that draws nothing. */
export function headline(query: Query, result: QueryResult | null): string {
  if (!result) return "no numbers (the read failed, or the widget waits for a scorer)";
  switch (result.kind) {
    case "metric":
    case "geography": {
      const unit = queryUnit(query) ?? "count";
      // The page's number, in plain spaces.
      const read = (value: number | null) => formatMetric(value, unit).replaceAll("\u00a0", " ");
      if (result.kind === "geography") {
        const top = result.places.slice(0, 3).map((p) => `${placeName(p.code)} ${read(p.value)}`);
        return `${top.join(", ") || "no located trace"} (${result.located.traces} of ${result.located.matched} traces located)`;
      }
      if (result.series.every(({ samples }) => samples === 0)) return "no data in this window";
      const [first] = result.series;
      if (first.groups.length === 0) return read(first.total);
      const rows = result.series
        .slice(0, 3)
        .map((s) => `${s.groups.map((g) => g.label ?? g.value).join(" / ")} ${read(s.total)}`);
      const more = result.series.length - rows.length;
      return `${rows.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
    }
    case "flow": {
      const [top] = result.edges;
      return top
        ? `${result.edges.length} moves over ${result.sample.read} traces, the most: ${top.source} to ${top.target} (${top.count})`
        : "no move in this window";
    }
    case "step_flow": {
      if (result.total === 0) return "no trace on the flow in this window";
      const steps = result.columns
        .filter(({ role }) => role === "step")
        .flatMap(({ step, nodes }) => {
          const top = nodes.find(({ kind }) => kind === "node");
          return top ? [`${step}. ${top.name} (${top.count})`] : [];
        });
      const before = query.kind === "step_flow" && query.mode === "before";
      const which = before ? `before ${query.target}, nearest first` : "the most at each step";
      return `${result.total} traces, ${which}: ${steps.join(", ") || "no step"}`;
    }
    case "funnel":
      return result.steps.map(({ name, count }) => `${name} ${count}`).join(" > ");
    case "clusters": {
      const { model, analyzedAt } = result as DashboardClusters;
      if (!analyzedAt) return "no stored analysis yet";
      return `${model.asks.length} clusters and ${model.capabilities.length} tools, analyzed ${analyzedAt.slice(0, 10)}`;
    }
    case "sql":
      return tableSummary(result);
  }
}

/** "2 rows of 2 columns: model, cost." The words of a table, for a host that draws nothing. */
export function tableSummary({ columns, rows, truncated }: SqlResult): string {
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  if (rows.length === 0) return `No row. The query has ${plural(columns.length, "column")}.`;
  const names = columns.map(({ name }) => name).join(", ");
  const cut = truncated ? " The query had more rows than its limit: these are the first ones." : "";
  return `${plural(rows.length, "row")} of ${plural(columns.length, "column")}: ${names}.${cut}`;
}

/** "2 scorers: Fast; Polite." */
export function countOf(count: number, noun: string, names: readonly string[]): string {
  if (count === 0) return `No ${noun} yet.`;
  const shown = names.slice(0, 10);
  const more = count - shown.length;
  return `${count} ${noun}${count === 1 ? "" : "s"}: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`;
}
