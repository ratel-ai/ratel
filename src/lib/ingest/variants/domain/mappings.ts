import type { AttrMap } from "@/lib/ingest/otlp/types";
import { scalarText, type VariantTags, variantTags } from "@/lib/ingest/variants/domain/tags";

/**
 * A project's mapping of one of its own span attributes (`app.variant`) to a
 * variant experiment (RC-869): the attribute's value is the variant name.
 */
export interface VariantMapping {
  attributeKey: string;
  experiment: string;
}

export type ParsedVariantMapping =
  | { ok: true; mapping: VariantMapping }
  | { ok: false; message: string };

export const MAX_MAPPING_FIELD_LENGTH = 256;
/** The keys the convention already reads: mapping them would change nothing. */
const RESERVED_PREFIX = "ratel.";

/**
 * The span's variant: its own `ratel.variant.*` tags when they name a variant,
 * else the first mapping whose key the span carries. The span's descriptors
 * stay either way.
 */
export function resolveSpanVariant(
  attributes: AttrMap,
  mappings: ReadonlyArray<VariantMapping>,
): VariantTags | null {
  const tags = variantTags(attributes);
  if (tags?.name) return tags;
  for (const mapping of mappings) {
    const name = scalarText(attributes[mapping.attributeKey]);
    if (name) return { experiment: mapping.experiment, name, descriptors: tags?.descriptors ?? {} };
  }
  return tags;
}

/** A mapping as a member typed it: both fields trimmed, non-blank and bounded; a `ratel.*` key is refused. */
export function parseVariantMapping(input: {
  attributeKey: unknown;
  experiment: unknown;
}): ParsedVariantMapping {
  const attributeKey = typeof input.attributeKey === "string" ? input.attributeKey.trim() : "";
  const experiment = typeof input.experiment === "string" ? input.experiment.trim() : "";
  if (!attributeKey || !experiment)
    return { ok: false, message: "Enter an attribute key and an experiment." };
  if (
    attributeKey.length > MAX_MAPPING_FIELD_LENGTH ||
    experiment.length > MAX_MAPPING_FIELD_LENGTH
  ) {
    return { ok: false, message: `Keep each field under ${MAX_MAPPING_FIELD_LENGTH} characters.` };
  }
  if (attributeKey.startsWith(RESERVED_PREFIX)) {
    return {
      ok: false,
      message: "Ratel already reads ratel.* attributes. Map one of your own keys.",
    };
  }
  return { ok: true, mapping: { attributeKey, experiment } };
}
