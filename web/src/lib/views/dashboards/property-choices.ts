import { listTraceProperties, type PropertyDb } from "@/lib/ingest/properties/store";
import { getPropertyFacets, type PropertyFacetsDb } from "@/lib/synthesis/traces/property-facets";
import type { PropertyChoices } from "./properties";

/**
 * The trace properties a form of one project offers (RTL-396): the indexed ones with their most
 * frequent values in the range (one bounded query, 50 values each), and the detected ones. A
 * standard property that is a column of every trace is a built-in field of the form, not one of
 * these. Server only: the dropdowns get it as data.
 */

export interface PropertyChoicesDeps {
  db: Pick<PropertyDb, "select"> & PropertyFacetsDb;
  /** Whether the plan indexes properties of the project's own. */
  entitled: boolean;
  /** The console's upgrade link; null when the edition sells no plan. */
  upgradeHref: string | null;
}

export async function loadPropertyChoices(
  projectId: string,
  range: { since: Date; until?: Date },
  { db, entitled, upgradeHref }: PropertyChoicesDeps,
): Promise<PropertyChoices> {
  const stored = (await listTraceProperties(projectId, db)).filter(({ column }) => !column);
  const indexed = stored.filter(({ state }) => state === "indexed").map(({ name }) => name);
  const values = await getPropertyFacets(projectId, indexed, range, db);
  return {
    indexed: indexed.map((name) => ({ name, values: values[name] ?? [] })),
    detected: stored
      .filter(({ state }) => state === "detected")
      .map(({ name, source }) => ({ name, source })),
    entitled,
    upgradeHref,
  };
}
