// Agent variant tags (CONVENTIONS.md § `ratel.variant.*`). `experimentalWithVariant`
// scopes a run to one variant through OTel baggage plus a typed context entry;
// `ExperimentalVariantSpanProcessor` copies them onto each span that starts in that scope.

import {
  type Attributes,
  type Context,
  context,
  createContextKey,
  propagation,
  type Span,
} from "@opentelemetry/api";
import {
  RATEL_VARIANT_BAGGAGE_PREFIX,
  RATEL_VARIANT_DESCRIPTOR_KEY_PATTERN,
  RATEL_VARIANT_EXPERIMENT,
  RATEL_VARIANT_EXPERIMENT_BAGGAGE_KEY,
  RATEL_VARIANT_MAX_DESCRIPTORS,
  RATEL_VARIANT_MAX_VALUE_LENGTH,
  RATEL_VARIANT_NAME,
  RATEL_VARIANT_NAME_BAGGAGE_KEY,
  RATEL_VARIANT_PREFIX,
} from "@ratel-ai/telemetry";

/** A descriptor value: content-free, and a string, a finite number or a boolean. */
export type VariantDescriptorValue = string | number | boolean;

/**
 * The variant of the agent one run uses. `experiment` and `name` are required; each other
 * key is a descriptor that becomes `ratel.variant.<key>` (for example `model` or
 * `prompt_version`).
 */
export interface VariantTags {
  /** The experiment the run belongs to (1 to 128 characters), for example `support-agent-model`. */
  experiment: string;
  /** The variant of that experiment the run uses (1 to 128 characters), for example `haiku`. */
  name: string;
  /** A content-free setting of the variant; the key matches `^[a-z][a-z0-9_]{0,63}$`. */
  [descriptor: string]: VariantDescriptorValue;
}

const VARIANT_ATTRIBUTES_KEY = createContextKey("ratel.variant.attributes");
const DESCRIPTOR_KEY = new RegExp(RATEL_VARIANT_DESCRIPTOR_KEY_PATTERN);
const RESERVED_KEYS = new Set(["experiment", "name"]);

const globalRef = globalThis as { console?: { warn?: (message: string) => void } };

/**
 * Run `fn` as one run of an agent variant. Each span that starts inside `fn` (the root
 * span of the run and its descendants, also across `await`) carries
 * `ratel.variant.experiment`, `ratel.variant.name` and one `ratel.variant.<key>` per
 * descriptor, when the host registers {@link ExperimentalVariantSpanProcessor} and an OTel
 * `ContextManager`. The tags also go into OTel baggage, so a propagator carries them to
 * other processes.
 *
 * An inner call replaces all tags of an outer call. An invalid descriptor is dropped with a
 * warning; more than 16 descriptors keep the first 16 in key order.
 *
 * Experimental: it can change without a major-version bump.
 *
 * @throws TypeError when `experiment` or `name` is not a string of 1 to 128 characters.
 *   `fn` does not run.
 */
export function experimentalWithVariant<T>(variant: VariantTags, fn: () => T): T {
  const attributes = variantAttributes(variant);
  const active = context.active();
  let baggage = propagation.getBaggage(active) ?? propagation.createBaggage();
  for (const [key] of baggage.getAllEntries()) {
    if (key.startsWith(RATEL_VARIANT_BAGGAGE_PREFIX)) baggage = baggage.removeEntry(key);
  }
  for (const [key, value] of Object.entries(attributes)) {
    baggage = baggage.setEntry(key, { value: String(value) });
  }
  const scoped = propagation
    .setBaggage(active, baggage)
    .setValue(VARIANT_ATTRIBUTES_KEY, attributes);
  return context.with(scoped, fn);
}

/**
 * A span processor that copies the variant tags of the current scope onto each span at
 * start. Add it to the host's tracer provider, beside the exporting processor:
 * `new NodeTracerProvider({ spanProcessors: [new ExperimentalVariantSpanProcessor(), ...] })`.
 *
 * Inside {@link experimentalWithVariant} it copies the typed values. Elsewhere it copies
 * `ratel.variant.*` baggage that came from another process, as strings, when that baggage
 * has both an experiment and a name.
 */
export class ExperimentalVariantSpanProcessor {
  /** Set the variant attributes of `parentContext` on `span`. */
  onStart(span: Span, parentContext: Context): void {
    const attributes =
      (parentContext.getValue(VARIANT_ATTRIBUTES_KEY) as Attributes | undefined) ??
      baggageAttributes(parentContext);
    if (attributes !== undefined) span.setAttributes(attributes);
  }

  /** Do nothing: the tags are set at start. */
  onEnd(): void {}

  /** Do nothing: the processor buffers nothing. */
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  /** Do nothing: the processor holds no resources. */
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

function variantAttributes(variant: VariantTags): Attributes {
  const { experiment, name, ...descriptors } = variant;
  requireBoundedString("experiment", experiment);
  requireBoundedString("name", name);
  const attributes: Attributes = {
    [RATEL_VARIANT_EXPERIMENT]: experiment,
    [RATEL_VARIANT_NAME]: name,
  };
  const dropped: string[] = [];
  let kept = 0;
  for (const key of Object.keys(descriptors).sort()) {
    const value: unknown = descriptors[key];
    if (!isValidDescriptor(key, value)) {
      dropped.push(key);
    } else if (kept >= RATEL_VARIANT_MAX_DESCRIPTORS) {
      dropped.push(key);
    } else {
      attributes[`${RATEL_VARIANT_PREFIX}${key}`] = value;
      kept += 1;
    }
  }
  if (dropped.length > 0) {
    globalRef.console?.warn?.(
      `ratel: dropped variant descriptors ${dropped.join(", ")}. A descriptor key matches ` +
        `${RATEL_VARIANT_DESCRIPTOR_KEY_PATTERN}, a value is a string of 1 to ` +
        `${RATEL_VARIANT_MAX_VALUE_LENGTH} characters, a finite number or a boolean, and a run ` +
        `has at most ${RATEL_VARIANT_MAX_DESCRIPTORS} descriptors.`,
    );
  }
  return attributes;
}

function baggageAttributes(parentContext: Context): Attributes | undefined {
  const baggage = propagation.getBaggage(parentContext);
  if (baggage === undefined) return undefined;
  const experiment = baggage.getEntry(RATEL_VARIANT_EXPERIMENT_BAGGAGE_KEY)?.value;
  const name = baggage.getEntry(RATEL_VARIANT_NAME_BAGGAGE_KEY)?.value;
  if (!isBoundedString(experiment) || !isBoundedString(name)) return undefined;
  const attributes: Attributes = {
    [RATEL_VARIANT_EXPERIMENT]: experiment,
    [RATEL_VARIANT_NAME]: name,
  };
  let kept = 0;
  const entries = baggage.getAllEntries().sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, entry] of entries) {
    if (!key.startsWith(RATEL_VARIANT_BAGGAGE_PREFIX)) continue;
    const descriptor = key.slice(RATEL_VARIANT_BAGGAGE_PREFIX.length);
    if (!isValidDescriptor(descriptor, entry.value)) continue;
    if (kept >= RATEL_VARIANT_MAX_DESCRIPTORS) break;
    attributes[key] = entry.value;
    kept += 1;
  }
  return attributes;
}

function requireBoundedString(field: string, value: unknown): void {
  if (!isBoundedString(value)) {
    throw new TypeError(
      `experimentalWithVariant: ${field} must be a string of 1 to ${RATEL_VARIANT_MAX_VALUE_LENGTH} characters`,
    );
  }
}

function isValidDescriptor(key: string, value: unknown): value is VariantDescriptorValue {
  if (RESERVED_KEYS.has(key) || !DESCRIPTOR_KEY.test(key)) return false;
  if (typeof value === "string") return isBoundedString(value);
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "boolean";
}

function isBoundedString(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  return [...value].length <= RATEL_VARIANT_MAX_VALUE_LENGTH;
}
