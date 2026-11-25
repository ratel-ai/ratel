import { z } from "zod";
import { hasNoNul, NUL_PROBLEM } from "@/lib/contracts/json-text";
import type { GeoAttributes } from "@/lib/ingest/geo/attributes";
import { isContentFreeAttributeKey } from "@/lib/ingest/otlp/span-rows";

const key = z
  .string()
  .trim()
  .min(1, "Give each attribute a name.")
  .max(200)
  .refine(hasNoNul, NUL_PROBLEM);
/** What spans keep of an export would keep the address or the coordinates with it. */
const unstored = key.refine((name) => !isContentFreeAttributeKey(name), {
  error: ({ input }) =>
    `Spans store "${String(input)}". An address or a coordinate must not be stored: send it under another name.`,
});

const schema = z.strictObject({
  address: unstored,
  country: key,
  region: key,
  latitude: unstored,
  longitude: unstored,
});

export type ParsedGeoAttributes =
  | { ok: true; attributes: GeoAttributes }
  | { ok: false; error: string };

export function parseGeoAttributes(raw: unknown): ParsedGeoAttributes {
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      error:
        parsed.error.issues[0].path.length > 0
          ? parsed.error.issues[0].message
          : "The attribute names are invalid.",
    };
  return { ok: true, attributes: parsed.data };
}
