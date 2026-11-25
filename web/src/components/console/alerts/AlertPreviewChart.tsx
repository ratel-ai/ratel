"use client";

import { cn } from "@ratel/design-system/cn";
import { EmptyState, Skeleton } from "@ratel/design-system/states";
import { ChartColumn } from "lucide-react";
import { useEffect, useState } from "react";
import {
  type AlertPreview,
  previewAlertAction,
} from "@/app/(console)/project/[projectId]/alerts/actions";
import type { MetricQuery } from "@/lib/contracts/query";
import { niceCeil } from "@/lib/platform/chart";
import { getMetric, nothingIsZero } from "@/lib/synthesis/metrics/catalog";
import { WINDOW_LABELS } from "@/lib/views/alerts/format";
import type { AlertWindow } from "@/lib/views/alerts/types";
import { chartModel, isEmptyResult } from "@/lib/views/dashboards/chart-model";
import { queryName } from "@/lib/views/dashboards/widget";
import { MetricChart } from "../dashboards/MetricChart";

const PREVIEW_DELAY_MS = 200;

/** The last 7 days of the metric, with the threshold as a line. */
export function AlertPreviewChart({
  projectId,
  query,
  windowMinutes,
  threshold,
}: {
  projectId: string;
  query: MetricQuery;
  windowMinutes: AlertWindow;
  threshold: number | null;
}) {
  const { preview, pending } = usePreview(projectId, query, windowMinutes);
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
      ) : isEmptyResult(preview.value.result) ? (
        <EmptyState
          icon={ChartColumn}
          title="No data in the last 7 days"
          description={
            nothingIsZero(preview.query.measures[0].aggregation)
              ? "The alert compares 0 until there is some."
              : "The alert stays on No data until there is some."
          }
        />
      ) : (
        <Chart
          query={preview.query}
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
  result: Extract<AlertPreview, { ok: true }>["result"];
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
function usePreview(projectId: string, query: MetricQuery, windowMinutes: AlertWindow) {
  const [preview, setPreview] = useState<{
    key: string;
    query: MetricQuery;
    windowMinutes: AlertWindow;
    value: AlertPreview;
  } | null>(null);
  const key = JSON.stringify([query, windowMinutes]);
  useEffect(() => {
    let stale = false;
    const [asked, minutes] = JSON.parse(key) as [MetricQuery, AlertWindow];
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
