import type { Tone } from "@ratel/design-system/badge";
import type {
  RuntimeEventClientDropGroup,
  RuntimeEventRejectRow,
  RuntimeEventRow,
  RuntimeSourceStatus,
} from "@/lib/ingest/runtime-events/queries";
import type { RuntimeEventsRange, RuntimeEventsTab } from "@/lib/ingest/runtime-events/view";

/**
 * Settings > Developer > SDK events (DESIGN.md, Glossary: "Runtime events"
 * become "SDK events"). Default views name every event in plain words; the
 * raw wire type stays in the Panel for the developer who needs it.
 */

export const SDK_EVENT_LABELS: Readonly<Record<string, string>> = {
  search: "Tool search",
  skill_search: "Skill search",
  gateway_search: "Gateway search",
  turn_start: "Turn started",
  skill_invoke: "Skill used",
  skill_churn: "Skill catalog changed",
  index_churn: "Tool catalog changed",
  invoke_start: "Tool call started",
  invoke_end: "Tool call finished",
  invoke_error: "Tool call failed",
  gateway_invoke: "Gateway call finished",
  gateway_error: "Gateway call failed",
  upstream_register: "Server connected",
  upstream_invoke: "Server call finished",
  upstream_error: "Server call failed",
  auth_refresh: "Sign-in refreshed",
  auth_needs: "Sign-in needed",
  auth_flow_start: "Sign-in started",
  auth_flow_end: "Sign-in finished",
  events_dropped: "Events dropped",
  usage_boost: "Ranking adjusted",
  usage_model_mismatch: "Ranking model mismatch",
  usage_cluster_policy_changed: "Ranking settings changed",
  usage_ranking_status: "Ranking status",
};

/** "custom_thing" becomes "Custom thing": a type a newer SDK sends still reads as words. */
export function humanizeEventType(type: string): string {
  const words = type
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
  if (!words) return "Unknown event";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function sdkEventLabel(type: string): string {
  return SDK_EVENT_LABELS[type] ?? humanizeEventType(type);
}

/** Failures read red, lost events amber, everything else stays gray. */
export function sdkEventTone(type: string): Exclude<Tone, "accent"> {
  if (type.endsWith("_error")) return "danger";
  if (type === "events_dropped" || type === "auth_needs" || type === "usage_model_mismatch")
    return "warning";
  return "neutral";
}

export const SDK_EVENT_WINDOWS: ReadonlyArray<{ value: RuntimeEventsRange; label: string }> = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

export function windowLabel(range: RuntimeEventsRange): string {
  return `Last ${SDK_EVENT_WINDOWS.find((option) => option.value === range)?.label ?? "7 days"}`;
}

export interface SdkEventsState {
  tab: RuntimeEventsTab;
  range: RuntimeEventsRange;
  type: string;
  sourceId: string;
}

/**
 * The page's URL for a state. Changing the window, a filter or the view drops
 * the open event, because the row it pointed at may no longer be listed.
 */
export function sdkEventsHref(root: string, state: SdkEventsState, event?: string | null): string {
  const params = new URLSearchParams();
  if (state.tab === "dropped") params.set("tab", "dropped");
  if (state.range !== "7d") params.set("range", state.range);
  if (state.type) params.set("type", state.type);
  if (state.sourceId) params.set("source", state.sourceId);
  if (event) params.set("event", event);
  const query = params.toString();
  return query ? `${root}?${query}` : root;
}

/** The panel param: the v1 page used `event`, and its links still arrive here. */
export const SDK_EVENT_PARAM = "event";

/**
 * How many rows a runtime events list read returns (RUNTIME_EVENTS_PAGE_SIZE,
 * kept equal by a test; that module reads the database, so the browser cannot
 * import it). A full list says it is the newest, not all.
 */
export const SDK_EVENT_LIST_LIMIT = 100;

export interface SdkEventView {
  key: string;
  /** What the URL names: the SDK's event id, or the stored row id. */
  identifier: string;
  type: string;
  label: string;
  tone: Exclude<Tone, "accent">;
  /** A query, a tool, a skill or a server, whichever the event is about. */
  subject: string | null;
  source: string | null;
  sourceStatus: RuntimeSourceStatus;
  /** ISO time the event happened (or was received, when the SDK sent no time). */
  at: string;
  receivedAt: string;
  durationMs: number | null;
  error: string | null;
  traceHref: string | null;
  ids: {
    event: string | null;
    invocation: string | null;
    trace: string | null;
    span: string | null;
  };
  values: {
    hits: number | null;
    topK: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
  };
}

/**
 * One event's payload, exactly as it arrived (pretty-printed). Loaded for the
 * open event only, never for the whole list.
 */
export interface SdkEventPayload {
  identifier: string;
  json: string;
}

function subjectOf(row: RuntimeEventRow): string | null {
  if (row.type === "events_dropped") {
    const count = Number(row.payload?.dropped_count ?? Number.NaN);
    return Number.isFinite(count) ? `${count} not sent` : null;
  }
  if (row.server && row.toolId) return `${row.server} · ${row.toolId}`;
  const upstream = typeof row.payload?.upstream === "string" ? row.payload.upstream : null;
  return row.query ?? row.toolId ?? row.skillId ?? row.server ?? upstream;
}

export function traceHrefFor(
  traceRoot: string,
  traceId: string | null,
  spanId: string | null,
): string | null {
  if (!traceId) return null;
  const span = spanId ? `?span=${encodeURIComponent(spanId)}` : "";
  return `${traceRoot}/${encodeURIComponent(traceId)}${span}`;
}

/**
 * A stored event as the table and its Panel read it, without its payload
 * (see `toSdkEventPayload`). Dates become ISO strings for the client.
 */
export function toSdkEventView(row: RuntimeEventRow, traceRoot: string): SdkEventView {
  return {
    key: row.id,
    identifier: row.eventId ?? row.id,
    type: row.type,
    label: sdkEventLabel(row.type),
    tone: sdkEventTone(row.type),
    subject: subjectOf(row),
    source: row.sourceId,
    sourceStatus: row.sourceStatus,
    at: (row.occurredAt ?? row.receivedAt).toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    durationMs: row.tookMs,
    error: row.errorMessage,
    traceHref: traceHrefFor(traceRoot, row.traceId, row.spanId),
    ids: { event: row.eventId, invocation: row.invocationId, trace: row.traceId, span: row.spanId },
    values: {
      hits: row.hitCount,
      topK: row.topK,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
    },
  };
}

export function toSdkEventPayload(
  row: Pick<RuntimeEventRow, "id" | "eventId" | "payload">,
): SdkEventPayload {
  return { identifier: row.eventId ?? row.id, json: JSON.stringify(row.payload ?? {}, null, 2) };
}

/** A source that went quiet says so; an active one needs no word. */
export function sourceStatusNote(status: RuntimeSourceStatus): string | null {
  switch (status) {
    case "stale":
      return "Quiet for 7 days";
    case "dormant":
      return "Quiet for 30 days";
    case "unknown":
      return "Not registered";
    default:
      return null;
  }
}

export interface SdkEventsSummary {
  /** Null when the count could not be read. */
  received: number | null;
  dropped: number | null;
  rejected: number | null;
  /** Sources that reported in the last 7 days. */
  sources: number;
}

/** Events the SDK shed before sending, summed over its `events_dropped` reports. */
export function droppedTotal(groups: readonly RuntimeEventClientDropGroup[] | null): number | null {
  if (!groups) return null;
  return groups.reduce((sum, group) => sum + group.droppedCount, 0);
}

/** One plain sentence for the summary: is the SDK getting its events through? */
export function summaryVerdict(
  summary: SdkEventsSummary,
): { tone: "success" | "warning" | "danger"; text: string } | null {
  const { received, dropped, rejected } = summary;
  if (received === null || dropped === null || rejected === null) return null;
  const refused = `Ratel Cloud refused ${countOf(rejected, "event")}`;
  const shed = `${countOf(dropped, "event")} before sending`;
  if (rejected > 0 && dropped > 0) {
    return { tone: "danger", text: `${refused}, and the SDK dropped ${shed}.` };
  }
  if (rejected > 0) {
    return {
      tone: "danger",
      text: `${refused}. Fix ${rejected === 1 ? "the reason it gives" : "the reasons they give"} and send again.`,
    };
  }
  if (dropped > 0) return { tone: "warning", text: `The SDK dropped ${shed}.` };
  if (received === 0) return null;
  return { tone: "success", text: "Every event in this window arrived." };
}

function countOf(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? noun : `${noun}s`}`;
}

export interface RejectView {
  key: string;
  at: string;
  reason: string;
  eventId: string | null;
  label: string | null;
  type: string | null;
  source: string | null;
  sizeBytes: number;
}

export function toRejectView(row: RuntimeEventRejectRow): RejectView {
  return {
    key: row.id,
    at: row.receivedAt.toISOString(),
    reason: row.reason,
    eventId: row.eventId,
    label: row.type ? sdkEventLabel(row.type) : null,
    type: row.type,
    source: row.sourceId,
    sizeBytes: row.sizeBytes,
  };
}

export interface DropView {
  key: string;
  source: string | null;
  reason: string | null;
  dropped: number;
  reports: number;
  lastAt: string;
}

export function toDropView(group: RuntimeEventClientDropGroup): DropView {
  return {
    key: `${group.sourceId ?? ""}:${group.reason ?? ""}`,
    source: group.sourceId,
    reason: group.reason,
    dropped: group.droppedCount,
    reports: group.windowCount,
    lastAt: group.lastDropAt.toISOString(),
  };
}
