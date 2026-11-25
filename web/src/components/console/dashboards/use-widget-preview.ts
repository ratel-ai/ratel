"use client";

import { useEffect, useState } from "react";
import {
  previewWidgetAction,
  type WidgetPreview,
} from "@/app/(console)/project/[projectId]/dashboards/actions";
import type { QueryResult } from "@/lib/synthesis/metrics/query";
import type { DashboardRange } from "@/lib/views/dashboards/links";
import type { DashboardFilters, WidgetInput } from "@/lib/views/dashboards/types";
import { canonicalJson } from "@/lib/views/dashboards/widget";

const PREVIEW_DELAY_MS = 200;
const UNREADABLE = "The numbers could not be read.";

/** The result with the widget it was read for: a chart never draws another widget's numbers. */
export type Preview =
  | (Extract<WidgetPreview, { ok: true }> & { widget: WidgetInput })
  | Extract<WidgetPreview, { ok: false }>;

/** Results the page came with, by `previewKey`; null for one that failed. */
export type ServedResults = ReadonlyMap<string, QueryResult | null>;

/** The widget's numbers as it changes. The last ones stay, dimmed, until the next arrive. */
export function useWidgetPreview(
  projectId: string,
  widget: WidgetInput,
  range: DashboardRange,
  filters: DashboardFilters,
  served?: ServedResults,
) {
  const key = previewKey(widget, range, filters);
  const [preview, setPreview] = useState<{ key: string; value: Preview } | null>(() =>
    servedPreview(key, widget, served),
  );
  const { preset, from, to } = range;
  useEffect(() => {
    let stale = false;
    const { asked, filters: narrowed } = JSON.parse(key) as Asked;
    const ready = servedPreview(key, asked, served);
    if (ready) {
      setPreview(ready);
      return;
    }
    const timer = setTimeout(async () => {
      let value: Preview;
      try {
        const read = await previewWidgetAction(projectId, asked, { preset, from, to }, narrowed);
        value = read.ok ? { ...read, widget: asked } : read;
      } catch {
        value = { ok: false, error: UNREADABLE };
      }
      if (!stale) setPreview({ key, value });
    }, PREVIEW_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [projectId, key, preset, from, to, served]);
  return { preview: preview?.value ?? null, pending: preview?.key !== key };
}

interface Asked {
  asked: WidgetInput;
  filters: DashboardFilters;
}

/** What decides the numbers, the same for the same question. The title changes none. */
export function previewKey(
  widget: WidgetInput,
  { preset, from, to }: DashboardRange,
  filters: DashboardFilters,
): string {
  const { query, chart } = widget;
  const asked = { asked: { title: "", query, chart }, filters, range: [preset, from, to] };
  return canonicalJson(asked);
}

function servedPreview(key: string, widget: WidgetInput, served: ServedResults | undefined) {
  const result = served?.get(key);
  if (result === undefined) return null;
  const value: Preview = result ? { ok: true, result, widget } : { ok: false, error: UNREADABLE };
  return { key, value };
}
