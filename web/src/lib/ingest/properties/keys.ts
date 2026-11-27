import { ancestorsOf, indexSpans } from "@/lib/ingest/otlp/attr-resolve";
import { isContentFreeAttributeKey } from "@/lib/ingest/otlp/span-rows";
import type { AttrMap, AttrValue, DecodedSpan } from "@/lib/ingest/otlp/types";
import { isCredentialKey } from "@/lib/ingest/otlp-raw/redact";
import { standardProperty, standardPropertyOf } from "./standard";

/**
 * The pure half of trace properties: which property keys an export carries, and the value of each
 * indexed property on each span. No database and no flag here: `ingest.ts` and the backfill call it.
 */

/** Who defines a property: the curated standard list, or the customer's own attribute key. */
export type PropertySource = "standard" | "user";

export interface PropertySighting {
  source: PropertySource;
  /** How many spans (or resources) of the export carried it. */
  count: number;
}

/** Each span's values, by span id: only the spans with at least one value. */
export type PropertyValuesBySpan = ReadonlyMap<string, Readonly<Record<string, string>>>;

/** The longest key name recorded. A longer key is not a property. */
export const MAX_KEY_LENGTH = 100;
/** A stored value is cut to this many characters. */
export const MAX_VALUE_LENGTH = 256;
export const NO_PROPERTY_VALUES: PropertyValuesBySpan = new Map();
/** The most attribute keys {@link propertyNameOf} remembers. */
const MAX_MEMO = 10_000;
const KEY_NAMES = new Map<string, string | null>();

/**
 * Keys that instrumentation writes about itself, never a customer's property: the OTel SDK and
 * process, and the namespaces of the conventions ingest maps. The metadata prefixes under them are
 * the customer's own keys and stay detectable.
 */
const INSTRUMENTATION_PREFIXES = [
  "otel.",
  "telemetry.",
  "process.",
  "ai.",
  "llm.",
  "input.",
  "output.",
  "openinference.",
  "traceloop.",
  "mastra.",
  "langfuse.",
  "logfire.",
  "mcp.",
  "gcp.vertex.agent.",
] as const;
const METADATA_PREFIXES = [
  "ai.telemetry.metadata.",
  "ai.settings.context.",
  "mastra.metadata.",
  "traceloop.association.properties.",
] as const;
/** A last key segment that names message content. */
const CONTENT_NAME =
  /^(prompts?|completions?|messages?|content|text|body|input|output|response|query|instructions?|arguments|args|result|documents?)$/;
/** A key that may hold an address or a position: the location attributes resolve and drop them. */
const LOCATION_NAME = /^(address|ip|client_ip|peer_ip|lat|lon|latitude|longitude)$/;

/** The property keys of an export: each span's keys, and each resource's keys once. */
export function detectPropertyKeys(spans: readonly DecodedSpan[]): Map<string, PropertySighting> {
  const detected = new Map<string, PropertySighting>();
  const resources = new Set<AttrMap>();
  const see = (attributes: AttrMap) => {
    for (const key in attributes) {
      const name = propertyNameOf(key);
      if (name === null || !isScalar(attributes[key])) continue;
      const standard = standardPropertyOf(key) !== undefined;
      const kept = detected.get(name);
      if (kept) kept.count += 1;
      else detected.set(name, { source: standard ? "standard" : "user", count: 1 });
    }
  };
  for (const span of spans) {
    see(span.attributes);
    if (resources.has(span.resourceAttributes)) continue;
    resources.add(span.resourceAttributes);
    see(span.resourceAttributes);
  }
  return detected;
}

/**
 * The property name of an attribute key: its canonical name, the key itself, or null for a key
 * that is no property. Memoized: an export repeats the same keys on every span.
 */
function propertyNameOf(key: string): string | null {
  let name = KEY_NAMES.get(key);
  if (name !== undefined) return name;
  name = standardPropertyOf(key)?.name ?? (isPropertyKey(key) ? key : null);
  if (KEY_NAMES.size >= MAX_MEMO) KEY_NAMES.clear();
  KEY_NAMES.set(key, name);
  return name;
}

/** The names whose values go in `properties`: a standard property with a column is not stored twice. */
export function storedPropertyNames(names: Iterable<string>): Set<string> {
  const stored = new Set<string>();
  for (const name of names) if (!standardProperty(name)?.column) stored.add(name);
  return stored;
}

/**
 * The value of each of `names` on each span: the span's own key, then its ancestors' in the
 * export, then its resource's, cut to {@link MAX_VALUE_LENGTH}. A standard name reads its keys in
 * priority order. Only scalar values; a number or a boolean is stored as its text.
 */
export function propertyValues(
  spans: readonly DecodedSpan[],
  names: ReadonlySet<string>,
): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  if (names.size === 0) return out;
  const lookups = [...names].map((name) => ({
    name,
    keys: standardProperty(name)?.keys ?? [name],
  }));
  const byId = indexSpans(spans);
  for (const span of spans) {
    const maps = [
      span.attributes,
      ...ancestorsOf(span, byId).map((ancestor) => ancestor.attributes),
      span.resourceAttributes,
    ];
    let values: Record<string, string> | undefined;
    for (const { name, keys } of lookups) {
      const value = firstScalar(maps, keys);
      if (value === undefined) continue;
      values ??= {};
      values[name] = value.slice(0, MAX_VALUE_LENGTH);
    }
    if (values) out.set(span.spanId, values);
  }
  return out;
}

/**
 * Whether a key the standard list does not map may be a property: short enough, not `gen_ai.*`,
 * `ratel.*` or a key spans store, not instrumentation, content, a credential or a location.
 */
export function isPropertyKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  if (key.startsWith("gen_ai.") || key.startsWith("ratel.") || isContentFreeAttributeKey(key))
    return false;
  if (standardProperty(key)) return false;
  if (
    INSTRUMENTATION_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
    !METADATA_PREFIXES.some((prefix) => key.startsWith(prefix) && key.length > prefix.length)
  )
    return false;
  if (key.startsWith("geo.") || isCredentialKey(key)) return false;
  const last = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  return !CONTENT_NAME.test(last) && !LOCATION_NAME.test(last);
}

function firstScalar(maps: readonly AttrMap[], keys: readonly string[]): string | undefined {
  for (const map of maps)
    for (const key of keys) {
      const value = map[key];
      if (isScalar(value)) return String(value).trim() || undefined;
    }
  return undefined;
}

function isScalar(value: AttrValue | undefined): value is string | number | boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return typeof value === "number" ? Number.isFinite(value) : typeof value === "boolean";
}
