/**
 * The sandbox side of the experimental SDK slots (`@ratel-ai/sdk/experimental/catalog`
 * and the SDK's registry of tools and skills). The SDK reads the active catalog host
 * from a global slot; this installs one host that serves the overrides and the
 * toolset of the current run, and collects the prompts and models the code reads.
 * `captureSetup` and `sdkSnapshot` read the SDK's registry of tools, skills and reads. Global slots, not imports, keep this
 * package free of an SDK dependency.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type CatalogKind = "prompt" | "model";

/** One prompt or model that code read, with the default it passed. */
export interface CatalogRead {
  readonly kind: CatalogKind;
  readonly id: string;
  readonly default: string;
  /** The local catalog file's value for this id, when it has one. */
  readonly catalog?: string;
}

/** The contract of the SDK's `globalThis[CATALOG_HOST_KEY]` slot. */
export interface CatalogHost {
  resolve(kind: CatalogKind, id: string): string | undefined;
  record(read: CatalogRead): void;
  toolset?<T>(tools: T): T;
  skills?(skills: readonly SkillView[]): readonly SkillView[];
}

/** A skill as the code offers it to the model (the SDK's `SkillView`). */
export interface SkillView {
  readonly id: string;
  readonly description: string;
  load(): Promise<string>;
}

/** What a run serves to the SDK besides prompt and model values. */
export interface RunServe {
  readonly toolset?: <T>(tools: T) => T;
  readonly skills?: (skills: readonly SkillView[]) => readonly SkillView[];
}

/** One tool registered on a `ratel()` core. `tool` is the object the app registered. */
export interface RegisteredTool {
  readonly id: string;
  readonly description: string;
  readonly inputSchema?: unknown;
  readonly tool: unknown;
}

/** One skill registered on a `ratel()` core. `skill` is the object the app registered. */
export interface RegisteredSkill {
  readonly id: string;
  readonly description: string;
  readonly skill?: unknown;
}

/** The SDK's `globalThis[REGISTRY_KEY]`: every tool, skill and catalog read in this process. */
export interface SdkRegistry {
  readonly tools: RegisteredTool[];
  readonly skills: RegisteredSkill[];
  readonly reads?: CatalogRead[];
}

/** What loading a sandbox file read from the catalog and registered on the SDK. */
export interface SetupCapture {
  readonly reads: readonly CatalogRead[];
  readonly tools: readonly RegisteredTool[];
  readonly skills: readonly RegisteredSkill[];
}

/** The overrides of one run, by catalog id. */
export interface CatalogOverrides {
  readonly prompts: Readonly<Record<string, string>>;
  readonly models: Readonly<Record<string, string>>;
}

/** Same key as the SDK's `CATALOG_HOST_KEY`. */
export const CATALOG_HOST_KEY: unique symbol = Symbol.for("ratel.catalog.host.v1") as never;

/** Same key as the SDK's `REGISTRY_KEY`. */
export const REGISTRY_KEY: unique symbol = Symbol.for("ratel.registry.v1") as never;

interface RunScope {
  readonly overrides: CatalogOverrides;
  readonly reads: Map<string, CatalogRead>;
  readonly serve: RunServe;
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
  toolset<T>(tools: T): T {
    return scope.getStore()?.serve.toolset?.(tools) ?? tools;
  },
  skills(skills) {
    return scope.getStore()?.serve.skills?.(skills) ?? skills;
  },
};

/**
 * Runs `fn` with `overrides` served to the catalog reads it makes, and returns the
 * prompts and models it read, in first-read order.
 */
export async function withCatalogRun<T>(
  overrides: CatalogOverrides,
  fn: () => T | Promise<T>,
  serve: RunServe = {},
): Promise<{ result: T; reads: CatalogRead[] }> {
  installHost();
  const run: RunScope = { overrides, reads: new Map(), serve };
  const result = await scope.run(run, fn);
  return { result, reads: [...run.reads.values()] };
}

/**
 * Runs `fn` (the import of a sandbox file) and returns the catalog reads and the SDK
 * registrations it added to the SDK registry. Loads run one after another: a module
 * that an earlier load already imported does not run again, so what it registered
 * counts for the earlier file only.
 */
export async function captureSetup<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; capture: SetupCapture }> {
  const before = sdkSnapshot();
  const seen = new Set<unknown>([...before.tools, ...before.skills, ...before.reads]);
  const result = await fn();
  const after = sdkSnapshot();
  return {
    result,
    capture: {
      reads: after.reads.filter((r) => !seen.has(r)),
      tools: after.tools.filter((t) => !seen.has(t)),
      skills: after.skills.filter((s) => !seen.has(s)),
    },
  };
}

/** Everything the SDK registry holds now: for a runner or a test that loads one agent. */
export function sdkSnapshot(): SetupCapture {
  const found = (globalThis as { [REGISTRY_KEY]?: SdkRegistry })[REGISTRY_KEY];
  return {
    tools: [...(found?.tools ?? [])],
    skills: [...(found?.skills ?? [])],
    reads: [...(found?.reads ?? [])],
  };
}

function installHost(): void {
  const slot = globalThis as { [CATALOG_HOST_KEY]?: CatalogHost };
  if (slot[CATALOG_HOST_KEY] !== host) slot[CATALOG_HOST_KEY] = host;
}
