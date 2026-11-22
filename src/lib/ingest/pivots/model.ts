import { SESSION_KEYS, USER_KEYS } from "@/lib/ingest/otlp/attr-resolve";

/**
 * Pivots (RC-881, switch `FF_PIVOTS`): the attributes a project slices its
 * traces by. Pure rules: the presets, key and label checks, the limit of 5
 * and the order. The table is `project_pivots` (lib/db/schema.ts).
 *
 * A preset pivot reads its preset's keys in order (the first one with a value
 * wins) and is stored under the preset id. A custom pivot reads one attribute
 * key, stored as its `key`.
 */

export interface PivotPreset {
  id: string;
  label: string;
  description: string;
  keys: readonly string[];
}

export interface Pivot {
  key: string;
  label: string;
  presetId: string | null;
  position: number;
}

/** What a person asks to add: a preset, or a custom attribute key. */
export type PivotInput = { presetId: string; label?: string } | { key: string; label?: string };

export type PivotError = "invalid_key" | "invalid_label" | "unknown_preset" | "duplicate" | "limit";

export type Checked = { ok: true; value: string } | { ok: false; error: PivotError };

export type PivotPlan = { ok: true; pivot: Pivot } | { ok: false; error: PivotError };

export const PIVOT_LIMIT = 5;
export const MAX_KEY_LENGTH = 128;
export const MAX_LABEL_LENGTH = 40;

/** The environment keys ingest reads (lib/otlp/span-rows.ts): the current one, then the legacy one. */
const ENVIRONMENT_KEYS = ["deployment.environment.name", "deployment.environment"] as const;
/**
 * Client company keys: OTel `enduser.org` and a common `tenant.id`. Owned (ADR-0030): upstream's
 * third key, the attribute its importer writes for an analytics vendor's company group, names the
 * vendor and is left out; a custom pivot can still read it.
 */
const CLIENT_KEYS = ["enduser.org", "tenant.id"] as const;
const KEY_PATTERN = /^[A-Za-z0-9_.\-:/]+$/;

export const PIVOT_PRESETS: readonly PivotPreset[] = [
  {
    id: "end_user",
    label: "End user",
    description: "The person your agent served.",
    keys: USER_KEYS,
  },
  {
    id: "session",
    label: "Session",
    description: "The conversation a run belongs to.",
    keys: SESSION_KEYS,
  },
  {
    id: "environment",
    label: "Environment",
    description: "Where the agent ran, such as production.",
    keys: ENVIRONMENT_KEYS,
  },
  {
    id: "client",
    label: "Client company",
    description: "The customer company of the end user.",
    keys: CLIENT_KEYS,
  },
];

/** Check what a person asks to add against the project's pivots. */
export function planPivot(existing: readonly Pivot[], input: PivotInput): PivotPlan {
  if (existing.length >= PIVOT_LIMIT) return { ok: false, error: "limit" };
  let key: string;
  let presetId: string | null = null;
  let defaultLabel: string;
  if ("presetId" in input) {
    const preset = presetFor(input.presetId);
    if (!preset) return { ok: false, error: "unknown_preset" };
    key = preset.id;
    presetId = preset.id;
    defaultLabel = preset.label;
  } else {
    const checked = validateCustomKey(input.key);
    if (!checked.ok) return checked;
    key = checked.value;
    defaultLabel = key.slice(0, MAX_LABEL_LENGTH);
  }
  const label =
    input.label === undefined || input.label.trim() === ""
      ? { ok: true as const, value: defaultLabel }
      : validateLabel(input.label);
  if (!label.ok) return label;
  if (existing.some((pivot) => pivot.key === key)) return { ok: false, error: "duplicate" };
  const position = existing.reduce((highest, pivot) => Math.max(highest, pivot.position + 1), 0);
  return { ok: true, pivot: { key, label: label.value, presetId, position } };
}

export function presetFor(id: string): PivotPreset | null {
  return PIVOT_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** The attribute keys a pivot reads, in priority order. */
export function pivotKeys(pivot: Pick<Pivot, "key" | "presetId">): readonly string[] {
  const preset = pivot.presetId ? presetFor(pivot.presetId) : null;
  return preset ? preset.keys : [pivot.key];
}

/** An attribute key: 1 to 128 of letters, digits and `_ . - : /`, and not a preset id. */
export function validateCustomKey(value: unknown): Checked {
  if (typeof value !== "string") return { ok: false, error: "invalid_key" };
  const key = value.trim();
  if (!key || key.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(key) || presetFor(key)) {
    return { ok: false, error: "invalid_key" };
  }
  return { ok: true, value: key };
}

/** A label: 1 to 40 characters after a trim. */
export function validateLabel(value: unknown): Checked {
  if (typeof value !== "string") return { ok: false, error: "invalid_label" };
  const label = value.trim();
  if (!label || label.length > MAX_LABEL_LENGTH) return { ok: false, error: "invalid_label" };
  return { ok: true, value: label };
}

/** The pivots in display order: by position, then by key. A new array. */
export function sortPivots<T extends Pick<Pivot, "key" | "position">>(pivots: readonly T[]): T[] {
  return [...pivots].sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
}

/**
 * The keys in their new order after one pivot moves up or down by one place.
 * An edge move keeps the order. Null when no pivot has that key.
 */
export function movePivot(
  pivots: readonly Pivot[],
  key: string,
  direction: "up" | "down",
): string[] | null {
  const keys = sortPivots(pivots).map((pivot) => pivot.key);
  const index = keys.indexOf(key);
  if (index < 0) return null;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= keys.length) return keys;
  [keys[index], keys[target]] = [keys[target], keys[index]];
  return keys;
}
