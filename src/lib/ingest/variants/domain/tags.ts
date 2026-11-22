import type { AttrMap } from "@/lib/ingest/otlp/types";

/**
 * The variant convention (RC-861): `ratel.variant.experiment` names the
 * experiment, `ratel.variant.name` the variant, and every other
 * `ratel.variant.<key>` is a free-form descriptor (`model`, `prompt_version`).
 */
export const RATEL_VARIANT = {
  prefix: "ratel.variant.",
  experiment: "ratel.variant.experiment",
  name: "ratel.variant.name",
} as const;

export interface VariantTags {
  experiment: string | null;
  name: string | null;
  /** The descriptors, keyed without the `ratel.variant.` prefix. Unbounded: the caller bounds them. */
  descriptors: Record<string, unknown>;
}

/** The variant tags of one span's attributes, or null when it has no `ratel.variant.*` key. */
export function variantTags(attributes: AttrMap): VariantTags | null {
  let tagged = false;
  const descriptors: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!key.startsWith(RATEL_VARIANT.prefix)) continue;
    tagged = true;
    if (key === RATEL_VARIANT.experiment || key === RATEL_VARIANT.name) continue;
    const descriptor = key.slice(RATEL_VARIANT.prefix.length);
    if (descriptor !== "") descriptors[descriptor] = value;
  }
  if (!tagged) return null;
  return {
    experiment: scalarText(attributes[RATEL_VARIANT.experiment]),
    name: scalarText(attributes[RATEL_VARIANT.name]),
    descriptors,
  };
}

/** A string or a finite number as trimmed text; anything else, or blank, is null. */
export function scalarText(value: unknown): string | null {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : null;
  const trimmed = text?.trim();
  return trimmed ? trimmed : null;
}
