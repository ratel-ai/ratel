import type { GeoAttributes } from "@/lib/ingest/geo/attributes";
import {
  GEO_COUNTRY_KEY,
  GEO_REGION_KEY,
  type GeoLookups,
  locateSpans,
} from "@/lib/ingest/geo/locate";
import { decodeOtlp, editOtlpExport } from "@/lib/ingest/otlp/decode";
import type { OtlpTransport } from "@/lib/ingest/otlp/http";

/**
 * An export whose address and coordinates are resolved and taken out, so it can wait in the ingest
 * queue: the queue stores the body, and a stored body must hold neither.
 */
export interface RedactedExport {
  /** The export in the format it came in, its spans marked with the codes. */
  body: Uint8Array;
  /** It carried an IP address: its raw body must not be kept. */
  addressed: boolean;
}

/** Null when the export holds nothing to take out. Throws when it does not decode. */
export async function redactExport(
  transport: OtlpTransport,
  bytes: Uint8Array,
  names: GeoAttributes,
  lookups: GeoLookups,
): Promise<RedactedExport | null> {
  const unstored = [names.address, names.latitude, names.longitude];
  // Protobuf holds a key as its bytes. JSON may escape it.
  if (transport === "protobuf" && !unstored.some((key) => Buffer.from(bytes).includes(key)))
    return null;
  const located = decodeOtlp(
    transport === "json" ? "application/json" : "application/x-protobuf",
    bytes,
  );
  const { addressed } = await locateSpans(located, names, lookups);
  let removed = false;
  const body = editOtlpExport(transport, bytes, (request) => {
    removed = withoutKeys(request, new Set(unstored));
    let at = 0;
    for (const { scopeSpans } of request.resourceSpans ?? [])
      for (const { spans } of scopeSpans ?? [])
        for (const span of spans ?? []) {
          const { attributes } = located[at++];
          const codes = [GEO_COUNTRY_KEY, GEO_REGION_KEY].flatMap((key) => {
            const value = attributes[key];
            return typeof value === "string" ? [{ key, value: { stringValue: value } }] : [];
          });
          // Ours alone: what the emitter sent under these names says nothing.
          span.attributes = [
            ...(span.attributes ?? []).filter(
              ({ key }) => key !== GEO_COUNTRY_KEY && key !== GEO_REGION_KEY,
            ),
            ...codes,
          ];
        }
  });
  return removed ? { body, addressed } : null;
}

/** Takes the attributes of these names out, at any depth. Returns whether there was one. */
function withoutKeys(value: unknown, keys: ReadonlySet<string>): boolean {
  if (typeof value !== "object" || value === null || ArrayBuffer.isView(value)) return false;
  let removed = false;
  for (const [name, child] of Object.entries(value)) {
    if (Array.isArray(child)) {
      const kept = child.filter((item) => !keys.has(item?.key));
      removed ||= kept.length < child.length;
      (value as Record<string, unknown>)[name] = kept;
      for (const item of kept) if (withoutKeys(item, keys)) removed = true;
    } else if (withoutKeys(child, keys)) removed = true;
  }
  return removed;
}
