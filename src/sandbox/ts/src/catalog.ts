/**
 * The sandbox side of the experimental prompt and model catalog
 * (`@ratel-ai/sdk/experimental/catalog`). The SDK reads the active host from a
 * global slot; this installs one host that serves the overrides of the current run
 * and collects the prompts and models the run's code reads. A global slot, not an
 * import, keeps this package free of an SDK dependency.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type CatalogKind = "prompt" | "model";

/** One prompt or model that code read, with the default it passed. */
export interface CatalogRead {
  readonly kind: CatalogKind;
  readonly id: string;
  readonly default: string;
}

/** The contract of the SDK's `globalThis[CATALOG_HOST_KEY]` slot. */
export interface CatalogHost {
  resolve(kind: CatalogKind, id: string): string | undefined;
  record(read: CatalogRead): void;
}

/** The overrides of one run, by catalog id. */
export interface CatalogOverrides {
  readonly prompts: Readonly<Record<string, string>>;
  readonly models: Readonly<Record<string, string>>;
}

/** Same key as the SDK's `CATALOG_HOST_KEY`. */
export const CATALOG_HOST_KEY: unique symbol = Symbol.for("ratel.catalog.host.v1") as never;

interface RunScope {
  readonly overrides: CatalogOverrides;
  readonly reads: Map<string, CatalogRead>;
}

const scope = new AsyncLocalStorage<RunScope>();

const host: CatalogHost = {
  resolve(kind, id) {
    const overrides = scope.getStore()?.overrides;
    return kind === "prompt" ? overrides?.prompts[id] : overrides?.models[id];
  },
  record(read) {
    const reads = scope.getStore()?.reads;
    const key = `${read.kind}:${read.id}`;
    if (reads && !reads.has(key)) reads.set(key, read);
  },
};

/**
 * Runs `fn` with `overrides` served to the catalog reads it makes, and returns the
 * prompts and models it read, in first-read order.
 */
export async function withCatalogRun<T>(
  overrides: CatalogOverrides,
  fn: () => T | Promise<T>,
): Promise<{ result: T; reads: CatalogRead[] }> {
  installHost();
  const run: RunScope = { overrides, reads: new Map() };
  const result = await scope.run(run, fn);
  return { result, reads: [...run.reads.values()] };
}

function installHost(): void {
  const slot = globalThis as { [CATALOG_HOST_KEY]?: CatalogHost };
  if (slot[CATALOG_HOST_KEY] !== host) slot[CATALOG_HOST_KEY] = host;
}
