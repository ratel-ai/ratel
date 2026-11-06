"use client";

import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Disclosure } from "@ratel/design-system/disclosure";
import { APP_NAME } from "@/lib/platform/app-config";

export type RankingMetric = {
  id: string;
  label: string;
  /** One line on what it measures. */
  meaning: string;
  without: number | null;
  withGraph: number | null;
  /** True for a share (shown as a percent), false for a score (three decimals). */
  share: boolean;
};

export type RankingClusterRow = {
  id: string;
  label: string;
  support: number;
  phrasings: number;
  topTool: string | null;
  lastSeen: string;
};

export type RankingDetailsData = {
  searches: number;
  estimated: boolean;
  metrics: RankingMetric[];
  verdict: { better: number; worse: number; same: number };
  liveRecall: { before: number; after: number } | null;
  facts: Array<{ label: string; value: string }>;
  clusters: RankingClusterRow[];
  clusterTotal: number;
};

const value = (metric: RankingMetric, raw: number | null) =>
  raw === null ? "No data" : metric.share ? `${Math.round(raw * 100)}%` : raw.toFixed(3);

function change(metric: RankingMetric): string {
  if (metric.without === null || metric.withGraph === null) return "No data";
  const delta = metric.withGraph - metric.without;
  if (metric.share) {
    const points = Math.round(delta * 100);
    return `${points > 0 ? "+" : ""}${points} pts`;
  }
  return `${delta > 0 ? "+" : ""}${delta.toFixed(3)}`;
}

const CLUSTER_COLUMNS: Column<RankingClusterRow>[] = [
  {
    id: "label",
    header: "Ask group",
    cell: (row) => (
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate">{row.label}</span>
        <span className="shrink-0 font-mono text-xs text-fg-subtle">{row.id}</span>
      </span>
    ),
  },
  {
    id: "support",
    header: "Support",
    align: "right",
    width: "6rem",
    cell: (row) => row.support.toLocaleString("en-US"),
  },
  {
    id: "phrasings",
    header: "Phrasings",
    align: "right",
    width: "6rem",
    cell: (row) => row.phrasings.toLocaleString("en-US"),
  },
  {
    id: "tool",
    header: "Top tool",
    width: "28%",
    className: "max-md:hidden",
    cell: (row) =>
      row.topTool ? (
        <span className="font-mono text-xs">{row.topTool}</span>
      ) : (
        <span className="text-fg-faint">None</span>
      ),
  },
  {
    id: "seen",
    header: "Last seen",
    align: "right",
    width: "8rem",
    cell: (row) => <span className="text-fg-muted">{row.lastSeen}</span>,
  },
];

/**
 * The specialist's view, closed by default: every retrieval metric with what
 * it means, the weighting rule, the per-search verdict, the graph's facts and
 * its ask groups with their raw ids.
 */
export function RankingDetails({ data }: { data: RankingDetailsData }) {
  return (
    <Disclosure title="Details" hint="Metrics, weighting and every ask group">
      <div className="flex flex-col gap-8" data-ranking-details="">
        <section aria-labelledby="ranking-metrics" className="flex flex-col gap-3">
          <div>
            <h3 id="ranking-metrics" className="text-sm font-semibold text-fg">
              Retrieval metrics
            </h3>
            <p className="mt-0.5 text-ui text-fg-muted">
              Over {data.searches.toLocaleString("en-US")} searches the agent acted on, scored on
              the tool it ran.
              {data.estimated
                ? ` Some rankings are ${APP_NAME}'s replay of your searches, not what a runtime served.`
                : ""}
            </p>
          </div>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full border-separate border-spacing-0 text-ui">
              <caption className="sr-only">
                Retrieval metrics with and without adaptive ranking
              </caption>
              <thead>
                <tr>
                  {["Metric", "What it measures", "Without", "With", "Change"].map(
                    (heading, index) => (
                      <th
                        key={heading}
                        scope="col"
                        className={`h-9 border-b border-line px-3 text-xs font-medium text-fg-subtle ${index >= 2 ? "text-right" : "text-left"}`}
                      >
                        {heading}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {data.metrics.map((metric) => (
                  <tr key={metric.id}>
                    <th
                      scope="row"
                      className="h-9 border-b border-line px-3 text-left font-mono text-xs font-normal text-fg"
                    >
                      {metric.label}
                    </th>
                    <td className="h-9 border-b border-line px-3 text-fg-muted">
                      {metric.meaning}
                    </td>
                    <td className="h-9 border-b border-line px-3 text-right text-fg tabular-nums">
                      {value(metric, metric.without)}
                    </td>
                    <td className="h-9 border-b border-line px-3 text-right text-fg tabular-nums">
                      {value(metric, metric.withGraph)}
                    </td>
                    <td className="h-9 border-b border-line px-3 text-right text-fg-muted tabular-nums">
                      {change(metric)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-ui text-fg-muted tabular-nums">
            Per search, ranked better with the graph {data.verdict.better.toLocaleString("en-US")}{" "}
            times, worse {data.verdict.worse.toLocaleString("en-US")} times and the same{" "}
            {data.verdict.same.toLocaleString("en-US")} times.
            {data.liveRecall
              ? ` Since a runtime started ranking from it, the tool the agent used was in the first five results ${Math.round(data.liveRecall.after * 100)}% of the time, against ${Math.round(data.liveRecall.before * 100)}% before.`
              : ""}
          </p>
        </section>

        <section aria-labelledby="ranking-weighting" className="flex flex-col gap-1">
          <h3 id="ranking-weighting" className="text-sm font-semibold text-fg">
            How a tool is weighted
          </h3>
          <p className="max-w-3xl text-ui text-fg-muted">
            Each ask group lifts the tools that answered it, in proportion to their calls. A group
            counts in full once it has three confirmed asks. A tool keeps{" "}
            <code className="font-mono text-xs text-fg">
              min(1, (calls + 3) / (times shown + 3))
            </code>{" "}
            of its weight, so one listed often and rarely picked lifts less.
          </p>
        </section>

        <section aria-labelledby="ranking-facts" className="flex flex-col gap-2">
          <h3 id="ranking-facts" className="text-sm font-semibold text-fg">
            The graph
          </h3>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-ui sm:grid-cols-4">
            {data.facts.map((fact) => (
              <div key={fact.label}>
                <dt className="text-xs text-fg-subtle">{fact.label}</dt>
                <dd className="text-fg tabular-nums">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-labelledby="ranking-clusters" className="flex flex-col gap-2">
          <h3 id="ranking-clusters" className="text-sm font-semibold text-fg">
            Ask groups
          </h3>
          <DataTable
            caption="Ask groups with their ids"
            columns={CLUSTER_COLUMNS}
            rows={data.clusters}
            rowKey={(row) => row.id}
            density="compact"
          />
          {data.clusterTotal > data.clusters.length ? (
            <p className="text-xs text-fg-subtle tabular-nums">
              The {data.clusters.length.toLocaleString("en-US")} strongest of{" "}
              {data.clusterTotal.toLocaleString("en-US")}. Intents lists them all.
            </p>
          ) : null}
        </section>
      </div>
    </Disclosure>
  );
}
