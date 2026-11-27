import { type MetricDimension, propertyOf } from "@/lib/contracts/query";

/**
 * The trace properties a form offers (RTL-396): in the Filter and Group by dropdowns of a metric,
 * under a heading of their own, and in the completion of the RQL field. An indexed property can be
 * picked, with the most frequent values of the range for its filter. A detected one is shown off:
 * picking it says it must be indexed first, or that indexing your own properties needs a paid
 * plan. A standard property that is a column of every trace is a built-in field, not one of these.
 * Pure and safe for the browser; `property-choices.ts` reads it on the server.
 */

/** A value of a property, and the traces of the range that hold it. */
export interface PropertyValue {
  value: string;
  count: number;
}

export interface PropertyChoices {
  /** The indexed properties, the most seen first, each with its most frequent values (50). */
  indexed: { name: string; values: PropertyValue[] }[];
  /** The detected ones: shown off, with why. */
  detected: { name: string; source: "standard" | "user" }[];
  /** Whether the plan lets a person index a property of the project's own. */
  entitled: boolean;
  /** The console's upgrade link; null when the edition sells no plan. */
  upgradeHref: string | null;
}

/** No property: the forms show the built-in fields only. */
export const NO_PROPERTIES: PropertyChoices = {
  indexed: [],
  detected: [],
  entitled: true,
  upgradeHref: null,
};

/** How a dropdown value names a property, apart from a built-in field. */
const PROPERTY_PREFIX = "property:";

/** The heading of the properties in a dropdown. */
export const PROPERTIES_HEADING = "Trace properties";

/** Why a detected property cannot be picked: what the tooltip says, with its link. */
export interface PropertyBlock {
  name: string;
  message: string;
  link: { href: string; label: string };
}

/** The section of project settings that lists the properties, opened on one of them. */
export function propertySettingsHref(projectId: string, name: string): string {
  return `/project/${encodeURIComponent(projectId)}/settings?property=${encodeURIComponent(name)}#trace-properties`;
}

/**
 * Why a property cannot be picked, or null when it is indexed. A property of the project's own on a
 * plan that does not index them needs a paid plan first; any other detected one needs indexing.
 */
export function propertyBlock(
  projectId: string,
  choices: PropertyChoices,
  name: string,
): PropertyBlock | null {
  if (choices.indexed.some((property) => property.name === name)) return null;
  const detected = choices.detected.find((property) => property.name === name);
  if (detected?.source === "user" && !choices.entitled)
    return {
      name,
      message: `Indexing your own properties, such as ${name}, needs a paid plan.`,
      link: choices.upgradeHref
        ? { href: choices.upgradeHref, label: "Upgrade" }
        : { href: propertySettingsHref(projectId, name), label: "See trace properties" },
    };
  return {
    name,
    message: `${name} must be indexed first to filter and group by it.`,
    link: { href: propertySettingsHref(projectId, name), label: "Index it in project settings" },
  };
}

/** One option of a dropdown: a property under the heading, off when it is only detected. */
export interface PropertyOption {
  value: string;
  label: string;
  group: string;
  muted?: boolean;
  detail?: string;
}

/**
 * The properties as options of a Filter or Group by dropdown: the indexed ones, then the detected
 * ones, off with "not indexed". `taken` are values the dropdown shows elsewhere already.
 */
export function propertyOptions(
  choices: PropertyChoices,
  taken: readonly string[] = [],
): PropertyOption[] {
  const option = (name: string): PropertyOption => ({
    value: `${PROPERTY_PREFIX}${name}`,
    label: name,
    group: PROPERTIES_HEADING,
  });
  return [
    ...choices.indexed.map(({ name }) => option(name)),
    ...choices.detected.map(({ name }) => ({
      ...option(name),
      muted: true,
      detail: "not indexed",
    })),
  ].filter(({ value }) => !taken.includes(value));
}

/** The value of a dimension in a dropdown: its name, or `property:<name>` for a property. */
export function dimensionValue(dimension: MetricDimension): string {
  const property = propertyOf(dimension);
  return property === undefined ? (dimension as string) : `${PROPERTY_PREFIX}${property}`;
}

/** The dimension of a dropdown value. */
export function dimensionOfValue(value: string): MetricDimension {
  return value.startsWith(PROPERTY_PREFIX)
    ? { property: value.slice(PROPERTY_PREFIX.length) }
    : (value as MetricDimension);
}

/** The property a dropdown value names, or undefined for a built-in field. */
export function propertyOfValue(value: string): string | undefined {
  return value.startsWith(PROPERTY_PREFIX) ? value.slice(PROPERTY_PREFIX.length) : undefined;
}
