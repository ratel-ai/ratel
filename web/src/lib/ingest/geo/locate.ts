import type { AddressLookup } from "@/lib/ingest/geo/address";
import type { GeoAttributes } from "@/lib/ingest/geo/attributes";
import type { ReverseLookup } from "@/lib/ingest/geo/boundaries";
import { countryCode, type GeoCodes, regionCode } from "@/lib/ingest/geo/codes";
import { attrNumber, attrString } from "@/lib/ingest/otlp/anyvalue";
import type { AttrMap, DecodedSpan } from "@/lib/ingest/otlp/types";

/**
 * A span's place, once, as it arrives: its address and its coordinates are in no stored row, so
 * later there is nothing to read. Only the codes stay, as two attributes of the stored span, and the
 * trace's summary takes them from there.
 */

export const GEO_COUNTRY_KEY = "ratel.geo.country";
export const GEO_REGION_KEY = "ratel.geo.region";

export interface GeoLookups {
  /** Null without a database file: addresses are then not resolved. */
  address: AddressLookup | null;
  /** Loaded only for a span with coordinates. */
  reverse: () => Promise<ReverseLookup>;
}

/** Marks each span that carries a location. Returns whether any carried an address. */
export async function locateSpans(
  spans: readonly DecodedSpan[],
  attributes: GeoAttributes,
  lookups: GeoLookups,
): Promise<{ addressed: boolean }> {
  // One client has many spans.
  const known = new Map<string, GeoCodes | null>();
  let addressed = false;
  for (const span of spans) {
    // Ours alone: what the emitter sent under these names says nothing.
    delete span.attributes[GEO_COUNTRY_KEY];
    delete span.attributes[GEO_REGION_KEY];
    addressed ||= hasValue(span, attributes.address);
    const place = await placeOf(span, attributes, lookups, known);
    if (!place) continue;
    span.attributes[GEO_COUNTRY_KEY] = place.country;
    if (place.region) span.attributes[GEO_REGION_KEY] = place.region;
  }
  return { addressed };
}

/** Codes first, then coordinates, then the address. */
async function placeOf(
  span: DecodedSpan,
  names: GeoAttributes,
  { address, reverse }: GeoLookups,
  known: Map<string, GeoCodes | null>,
): Promise<GeoCodes | null> {
  const country = countryCode(read(span, names.country));
  if (country) return { country, region: regionCode(read(span, names.region), country) };
  const latitude = readNumber(span, names.latitude);
  const longitude = readNumber(span, names.longitude);
  if (latitude !== undefined && longitude !== undefined) {
    const key = `${latitude},${longitude}`;
    let place = known.get(key);
    if (place === undefined) {
      place = (await reverse())(latitude, longitude);
      known.set(key, place);
    }
    if (place) return place;
  }
  const raw = read(span, names.address);
  if (!raw || !address) return null;
  let place = known.get(raw);
  if (place === undefined) {
    place = address(raw);
    known.set(raw, place);
  }
  return place;
}

/** Whatever its type: OpenTelemetry defines a captured header as a list. */
function hasValue(span: DecodedSpan, key: string): boolean {
  return [span.attributes[key], span.resourceAttributes[key]].some(
    (value) =>
      value !== undefined &&
      value !== null &&
      value !== "" &&
      !(Array.isArray(value) && value.length === 0),
  );
}

/** The span's own attribute, else its resource's. */
function read(span: DecodedSpan, key: string): string | undefined {
  return from(span, (map) => attrString(map, key));
}

function readNumber(span: DecodedSpan, key: string): number | undefined {
  return from(span, (map) => (map[key] === "" ? undefined : attrNumber(map, key)));
}

function from<T>(span: DecodedSpan, of: (map: AttrMap) => T | undefined): T | undefined {
  return of(span.attributes) ?? of(span.resourceAttributes);
}
