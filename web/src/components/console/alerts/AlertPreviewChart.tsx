"use client";

import { cn } from "@ratel/design-system/cn";
import { Callout, EmptyState, Skeleton } from "@ratel/design-system/states";
import { ChartColumn } from "lucide-react";
import { useEffect, useState } from "react";
import {
  type AlertPreview,
  previewAlertAction,
} from "@/app/(console)/project/[projectId]/alerts/actions";
import type { MetricQuery } from "@/lib/contracts/query";
import { niceCeil } from "@/lib/platform/chart";
import { getMetric, nothingIsZero } from "@/lib/synthesis/metrics/catalog";
import type { MetricResult } from "@/lib/synthesis/metrics/query";
import { WINDOW_LABELS } from "@/lib/views/alerts/format";
import type { AlertQuery, AlertWindow } from "@/lib/views/alerts/types";
import { chartModel, isEmptyResult } from "@/lib/views/dashboards/chart-model";
import { metricOfForm, queryName } from "@/lib/views/dashboards/widget";
import { MetricChart } from "../dashboards/MetricChart";

const PREVIEW_DELAY_MS = 200;
const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

/** The last 7 days of the metric, with the threshold as a line; the value of RQL text now. */
export function AlertPreviewChart({
  projectId,
  query,
  windowMinutes,
  threshold,
}: {
  projectId: string;
  query: AlertQuery;
  windowMinutes: AlertWindow;
  threshold: number | null;
}) {
  const { preview, pending } = usePreview(projectId, query, windowMinutes);
  if (!query.form)
    return (
      <section
        aria-label="Value now"
        aria-busy={pending || undefined}
        className={cn(
          "rounded-lg border border-line p-4 transition-opacity duration-160",
          pending && preview && "opacity-60",
        )}
      >
        <h3 className="mb-2 text-sm font-semibold text-fg">
          Value now, over the last {WINDOW_LABELS[windowMinutes]}
        </h3>
        {!preview ? (
          <Skeleton className="h-8 w-40" />
        ) : !preview.value.ok ? (
          <p role="status" className="text-sm text-danger">
            {preview.value.error}
          </p>
        ) : preview.value.result.kind !== "sql_value" ? null : preview.value.result.error ? (
          <Callout tone="danger" title="The alert would be failing">
            {preview.value.result.error}
          </Callout>
        ) : (
          <SqlValue value={preview.value.result.value} threshold={threshold} />
        )}
      </section>
    );
  return (
    <section
      aria-label="Last 7 days"
      aria-busy={pending || undefined}
      className={cn(
        "min-h-56 rounded-lg border border-line p-4 transition-opacity duration-160",
        pending && preview && "opacity-60",
      )}
    >
      <h3 className="mb-3 text-sm font-semibold text-fg">Last 7 days</h3>
      {!preview ? (
        <Skeleton className="h-40 w-full" />
      ) : !preview.value.ok ? (
        <p role="status" className="text-sm text-danger">
          {preview.value.error}
        </p>
      ) : preview.value.result.kind !== "metric" || !preview.query.form ? null : isEmptyResult(
          preview.value.result,
        ) ? (
        <EmptyState
          icon={ChartColumn}
          title="No data in the last 7 days"
          description={
            nothingIsZero(preview.query.form.measures[0].aggregation)
              ? "The alert compares 0 until there is some."
              : "The alert stays on No data until there is some."
          }
        />
      ) : (
        <Chart
          query={metricOfForm(preview.query.form)}
          windowMinutes={preview.windowMinutes}
          result={preview.value.result}
          threshold={threshold}
        />
      )}
    </section>
  );
}

function Chart({
  query,
  windowMinutes,
  result,
  threshold,
}: {
  query: MetricQuery;
  windowMinutes: AlertWindow;
  result: MetricResult;
  threshold: number | null;
}) {
  const [{ measure, aggregation }] = query.measures;
  const unit = getMetric(measure)?.unit ?? "count";
  const model = chartModel(result, aggregation, unit, "line");
  const scaleMax = Math.max(model.scaleMax, threshold === null ? 0 : niceCeil(threshold));
  return (
    <>
      <MetricChart
        chart="line"
        model={{ ...model, scaleMax }}
        result={result}
        unit={unit}
        label={queryName(query)}
        threshold={threshold ?? undefined}
      />
      <p className="mt-2 text-xs text-fg-subtle">
        {`Each point is one ${result.bucket}. Here a trace counts when it started. The alert compares the last ${WINDOW_LABELS[windowMinutes]}.`}
      </p>
    </>
  );
}

/** The last numbers stay, dimmed and with the query they were read for, until the next arrive. */
function usePreview(projectId: string, query: AlertQuery, windowMinutes: AlertWindow) {
  const [preview, setPreview] = useState<{
    key: string;
    query: AlertQuery;
    windowMinutes: AlertWindow;
    value: AlertPreview;
  } | null>(null);
  const key = JSON.stringify([query, windowMinutes]);
  useEffect(() => {
    let stale = false;
    const [asked, minutes] = JSON.parse(key) as [AlertQuery, AlertWindow];
    const timer = setTimeout(async () => {
      const value = await previewAlertAction(projectId, asked, minutes).catch(
        (): AlertPreview => ({ ok: false, error: "The numbers could not be read." }),
      );
      if (!stale) setPreview({ key, query: asked, windowMinutes: minutes, value });
    }, PREVIEW_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [projectId, key]);
  return { preview, pending: preview?.key !== key };
}

/** The value the alert compares now, and whether it is over or under the threshold. */
function SqlValue({ value, threshold }: { value: number | null; threshold: number | null }) {
  if (value === null)
    return (
      <p className="text-sm text-fg-muted">
        No data: the query gave no value. The alert stays on No data.
      </p>
    );
  return (
    <p className="text-sm text-fg">
      <span className="text-2xl font-semibold tabular-nums">{NUMBER.format(value)}</span>
      {threshold !== null ? (
        <span className="ml-3 text-fg-muted">
          {value > threshold ? "above" : value < threshold ? "below" : "on"} the threshold of{" "}
          {NUMBER.format(threshold)}
        </span>
      ) : null}
    </p>
  );
}
