import type { RuntimeSourceStatus } from "@/lib/ingest/runtime-events/queries";

export type RuntimeEventsTab = "events" | "dropped";
export type RuntimeEventsRange = "24h" | "7d" | "30d";

export interface RuntimeEventsSearchParams {
  tab?: string | readonly string[];
  range?: string | readonly string[];
  type?: string | readonly string[];
  source?: string | readonly string[];
  event?: string | readonly string[];
}

export interface RuntimeEventsView {
  tab: RuntimeEventsTab;
  range: RuntimeEventsRange;
  type: string;
  sourceId: string;
  selectedEventId: string;
  since: Date;
  until: Date;
}

const RANGE_MS: Record<RuntimeEventsRange, number> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

export function resolveRuntimeEventsView(
  params: RuntimeEventsSearchParams,
  now = new Date(),
): RuntimeEventsView {
  const rawRange = textParam(params.range);
  const range: RuntimeEventsRange = rawRange === "24h" || rawRange === "30d" ? rawRange : "7d";
  const until = new Date(now);
  return {
    tab: textParam(params.tab) === "dropped" ? "dropped" : "events",
    range,
    type: textParam(params.type),
    sourceId: textParam(params.source),
    selectedEventId: textParam(params.event),
    since: new Date(until.getTime() - RANGE_MS[range]),
    until,
  };
}

export function runtimeEventsHref(
  root: string,
  view: Pick<RuntimeEventsView, "range" | "type" | "sourceId">,
  updates: {
    tab?: RuntimeEventsTab;
    event?: string | null;
  },
): string {
  const params = new URLSearchParams();
  if (updates.tab === "dropped") params.set("tab", "dropped");
  if (view.range !== "7d") params.set("range", view.range);
  if (view.type) params.set("type", view.type);
  if (view.sourceId) params.set("source", view.sourceId);
  if (updates.event) params.set("event", updates.event);
  const query = params.toString();
  return query ? `${root}?${query}` : root;
}

export function sourceStatusLabel(status: RuntimeSourceStatus): string {
  switch (status) {
    case "active":
      return "active";
    case "stale":
      return "stale · 7d+";
    case "dormant":
      return "dormant · 30d+";
    case "unknown":
      return "unregistered";
  }
}

function textParam(value: string | readonly string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}
