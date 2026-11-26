import type { AddressLookup } from "@/lib/ingest/geo/address";
import type { GeoAttributes } from "@/lib/ingest/geo/attributes";
import type { ReverseLookup } from "@/lib/ingest/geo/boundaries";
import { countryCode, type GeoCodes, regionCode } from "@/lib/ingest/geo/codes";
import { attrNumber, attrString } from "@/lib/ingest/otlp/anyvalue";
import type { AttrMap, DecodedSpan } from "@/lib/ingest/otlp/types";
import { getLogger } from "@/lib/platform/logger";

/**
 * A span's place, once, as it arrives: its address and its coordinates are in no stored row, so
 * later there is nothing to read. Only the codes stay, as two attributes of the stored span, and the
 * trace's summary takes them from there.
 */

export const GEO_COUNTRY_KEY = "ratel.geo.country";
export const GEO_REGION_KEY = "ratel.geo.region";
/** Distinct coordinates and addresses one batch looks up at most; a span past it is not located. */
export const MAX_GEO_LOOKUPS = 1_000;
/** The longest run of lookups before the process takes its other work: a lookup is synchronous. */
const SLICE_MS = 10;

export interface GeoLookups {
  /** Null without a database file: addresses are then not resolved. */
  address: AddressLookup | null;
  /** Loaded only for a span with coordinates. */
  reverse: () => Promise<ReverseLookup>;
}

const logger = getLogger("ingest/geo");

/** The distinct places a batch looked up, and when the process last took its other work. */
interface Lookups {
  known: Map<string, GeoCodes | null>;
  made: number;
  sliceStart: number;
}

/**
 * Marks each span that carries a location. Returns whether any carried an address. A lookup is
 * synchronous, so the batch gives the process back each `SLICE_MS`, and it looks up
 * `MAX_GEO_LOOKUPS` distinct places at most. Codes need no lookup.
 */
export async function locateSpans(
  spans: readonly DecodedSpan[],
  attributes: GeoAttributes,
  lookups: GeoLookups,
): Promise<{ addressed: boolean }> {
  // One client has many spans.
  const state: Lookups = { known: new Map(), made: 0, sliceStart: performance.now() };
  let addressed = false;
  for (const span of spans) {
    // Ours alone: what the emitter sent under these names says nothing.
    delete span.attributes[GEO_COUNTRY_KEY];
    delete span.attributes[GEO_REGION_KEY];
    addressed ||= hasValue(span, attributes.address);
    const place = await placeOf(span, attributes, lookups, state);
    if (place) {
      span.attributes[GEO_COUNTRY_KEY] = place.country;
      if (place.region) span.attributes[GEO_REGION_KEY] = place.region;
    }
    if (performance.now() - state.sliceStart >= SLICE_MS) {
      await new Promise((resolve) => setImmediate(resolve));
      state.sliceStart = performance.now();
    }
  }
  // Counts only: a log never holds a place or an address.
  if (state.made >= MAX_GEO_LOOKUPS)
    logger.warn({ spans: spans.length, lookups: state.made }, "geo lookups capped for a batch");
  return { addressed };
}

/** Codes first, then coordinates, then the address. */
async function placeOf(
  span: DecodedSpan,
  names: GeoAttributes,
  { address, reverse }: GeoLookups,
  state: Lookups,
): Promise<GeoCodes | null> {
  const country = countryCode(read(span, names.country));
  if (country) return { country, region: regionCode(read(span, names.region), country) };
  const latitude = readNumber(span, names.latitude);
  const longitude = readNumber(span, names.longitude);
  if (latitude !== undefined && longitude !== undefined) {
    const lookup = await reverse();
    const place = looked(state, `${latitude},${longitude}`, () => lookup(latitude, longitude));
    if (place) return place;
  }
  const raw = read(span, names.address);
  if (!raw || !address) return null;
  return looked(state, raw, () => address(raw));
}

/** The place of `key`: known, else looked up while the batch has lookups left, else none. */
function looked(state: Lookups, key: string, lookup: () => GeoCodes | null): GeoCodes | null {
  const kept = state.known.get(key);
  if (kept !== undefined) return kept;
  if (state.made >= MAX_GEO_LOOKUPS) return null;
  state.made += 1;
  const place = lookup();
  state.known.set(key, place);
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
