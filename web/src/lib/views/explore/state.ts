import { z } from "zod";
import { ATTRIBUTE_PREFIX, isComparable } from "@/lib/contracts/check";
import { type FunnelCondition, type FunnelStep, QUERY_VERSION } from "@/lib/contracts/query";
import { pack, unpack, unpackPlain } from "@/lib/synthesis/traces/compact-json";
import { MAX_SEARCH_CHARS } from "@/lib/views/dashboards/filters";
import { EXACT_RANGE } from "@/lib/views/dashboards/links";
import { parseWidget } from "@/lib/views/dashboards/parse-widget";
import { MAX_WIDGET_TITLE, type WidgetInput } from "@/lib/views/dashboards/types";
import { START_PANEL } from "@/lib/views/explore/starts";
import { MAX_PANELS } from "@/lib/views/explore/types";

/**
 * The panels in the address: a version, then base64url of deflated JSON that leaves out what the
 * query contract fills in. A short value is a search parameter, so the server reads it. A longer
 * one is the fragment, which no request carries: browsers take far more than `MAX_STATE_CHARS`
 * there. The contract bounds a query, so four of the longest fit. Safe for the browser.
 */

export const PANELS_PARAM = "panels";
/** The parameter's value while the panels are in the fragment. */
export const IN_FRAGMENT = "hash";
/** A change of what the value means is a new version. "1" is the same JSON, not deflated. */
const STATE_VERSION = "2";
/** A funnel of eight steps with the longest texts, and the longest filter. */
const MAX_PANEL_BYTES = 40_000;
const MAX_STATE_BYTES = MAX_PANELS * MAX_PANEL_BYTES;
/** Base64 is 4 characters for 3 bytes, and deflate adds little to what it cannot shorten. */
export const MAX_STATE_CHARS = 220_000;

const LOST = "The link lost its panels on the way here. Open the link again.";

export type ParsedPanels = { ok: true; panels: WidgetInput[] } | { ok: false; error: string };

export function encodePanels(panels: readonly WidgetInput[]): string {
  return `${STATE_VERSION}.${pack(panels.map(compact))}`;
}

/** The panels of a value, the start panel without one, or why they cannot be shown. */
export function decodePanels(value: string | null): ParsedPanels {
  if (!value) return { ok: true, panels: [START_PANEL] };
  const [version, encoded] = [value.slice(0, 1), value.slice(2)];
  if (value[1] !== "." || (version !== STATE_VERSION && version !== "1"))
    return { ok: false, error: "The link is from another version of Explore." };
  if (value.length > MAX_STATE_CHARS) return { ok: false, error: "The link is too long." };
  const stored = stateSchema.safeParse(
    version === STATE_VERSION ? unpack(encoded, MAX_STATE_BYTES) : unpackPlain(encoded),
  );
  if (!stored.success) return { ok: false, error: "The link is damaged." };
  const panels: WidgetInput[] = [];
  for (const { title, chart, query } of stored.data) {
    const panel = parsePanel({ title, chart, query: { ...query, version: QUERY_VERSION } });
    if (!panel.ok) return panel;
    panels.push(panel.widget);
  }
  return { ok: true, panels };
}

/** The panels of an address; null while only its fragment, which a server has not, can say. */
export function panelsOfAddress(search: string, hash: string | null): ParsedPanels | null {
  const value = new URLSearchParams(search).get(PANELS_PARAM);
  if (value !== IN_FRAGMENT) return decodePanels(value);
  if (hash === null) return null;
  return hash.length > 1 ? decodePanels(hash.slice(1)) : { ok: false, error: LOST };
}

/** An address with other panels; the rest of it stays. It has a fragment when they are long. */
export function withPanels(search: string, panels: readonly WidgetInput[]): string {
  const params = new URLSearchParams(withoutFragment(search));
  const value = encodePanels(panels);
  params.set(PANELS_PARAM, value);
  const address = `?${params}`;
  if (address.length <= MAX_SEARCH_CHARS) return address;
  params.set(PANELS_PARAM, IN_FRAGMENT);
  return `?${params}#${value}`;
}

/** An address with the start panel; the filters stay, and the range unless it is exact. */
export function withoutPanels(search: string): string {
  const params = new URLSearchParams(withoutFragment(search));
  params.delete(PANELS_PARAM);
  if (params.get("range") === EXACT_RANGE)
    for (const name of ["range", "from", "to"]) params.delete(name);
  return params.size > 0 ? `?${params}` : "";
}

export function withoutFragment(search: string): string {
  return search.split("#")[0];
}

/** What identifies the panels of an address. */
export function stateOfAddress(search: string, hash: string): string | null {
  const value = new URLSearchParams(search).get(PANELS_PARAM);
  return value === IN_FRAGMENT ? hash.slice(1) : value;
}

/** Why a panel cannot be shown, and so be in the address; null for one that is only not complete. */
export function panelProblem(panel: WidgetInput): string | null {
  if (panel.title.length > MAX_WIDGET_TITLE)
    return `A title has ${MAX_WIDGET_TITLE} characters at most.`;
  const parsed = parsePanel(panel);
  return parsed.ok ? null : parsed.error;
}

const stateSchema = z
  .array(
    z.strictObject({
      title: z.string().optional(),
      chart: z.string(),
      query: z.record(z.string(), z.unknown()),
    }),
  )
  .min(1)
  .max(MAX_PANELS);

/** A panel, also one with a text a person has not written yet: it is kept as it is. */
function parsePanel(raw: { title?: string; chart: string; query: Record<string, unknown> }) {
  const parsed = parseWidget(raw);
  if (parsed.ok) return parsed;
  const query = completed(raw.query);
  if (!query) return parsed;
  const filled = parseWidget({ ...raw, query });
  if (!filled.ok) return filled;
  const { widget } = filled;
  const own = raw.query as { steps: FunnelStep[]; target?: string };
  if (widget.query.kind === "funnel")
    return {
      ok: true as const,
      widget: { ...widget, query: { ...widget.query, steps: own.steps } },
    };
  if (widget.query.kind === "step_flow")
    return {
      ok: true as const,
      widget: { ...widget, query: { ...widget.query, target: own.target ?? "" } },
    };
  return parsed;
}

/** The query with a stand-in for each text not written yet; null for a kind that has none. */
function completed(query: Record<string, unknown>): Record<string, unknown> | null {
  if (query.kind === "step_flow" && query.mode === "before")
    return { ...query, target: written(query.target) };
  if (query.kind !== "funnel" || !Array.isArray(query.steps)) return null;
  return {
    ...query,
    steps: query.steps.map((step) => ({
      ...step,
      name: written(step?.name),
      ...(isObject(step?.condition) ? { condition: completedCondition(step.condition) } : {}),
    })),
  };
}

function completedCondition(condition: Record<string, unknown>): Record<string, unknown> {
  const { type, name, path, op, value } = condition as Partial<
    Extract<FunnelCondition, { type: "attribute" }>
  > & { name?: unknown };
  if ((type as string) === "tool" || (type as string) === "skill")
    return { ...condition, name: written(name) };
  if (type !== "attribute") return condition;
  const unwritten = value === undefined || (typeof value === "string" && !value.trim());
  const unread = typeof value === "string" && op !== undefined && !isComparable(op, value);
  return {
    ...condition,
    path: path?.trim?.() === ATTRIBUTE_PREFIX ? `${ATTRIBUTE_PREFIX}x` : path,
    ...(op !== "exists" && (unwritten || unread) ? { value: "1" } : {}),
  };
}

function written(text: unknown): unknown {
  return text === undefined || (typeof text === "string" && !text.trim()) ? "x" : text;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function compact({ title, chart, query }: WidgetInput) {
  const { version: _, ...rest } = query;
  const said = Object.entries(rest).filter(
    ([, value]) => typeof value !== "object" || Object.keys(value ?? {}).length > 0,
  );
  return { ...(title ? { title } : {}), chart, query: Object.fromEntries(said) };
}
