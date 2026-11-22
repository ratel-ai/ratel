// The process registry of SDK registrations: every tool and skill registered on any
// `ratel()` core in this process. It lives on a `globalThis` slot, not in a module
// variable, so `@ratel-ai/sandbox` can read it without depending on this package,
// and two copies of this package fill one registry. A Ratel sandbox turns these
// registrations into params (ADR-less, experimental: see prompt-model-catalog.ts).

/** One registered tool. `tool` is the object the app registered (a framework tool on an adapted view). */
export interface RegisteredTool {
  readonly id: string;
  readonly description: string;
  readonly inputSchema?: unknown;
  readonly tool: unknown;
}

/** One registered skill. `skill` is the object the app registered (its MCP-style `annotations` give a sandbox its hint). */
export interface RegisteredSkill {
  readonly id: string;
  readonly description: string;
  readonly skill: unknown;
}

/** One prompt or model read through the catalog, with the default the code passed. */
export interface RegisteredRead {
  readonly kind: "prompt" | "model";
  readonly id: string;
  readonly default: string;
  /** The local catalog file's value for this id at the first read, when it has one. */
  readonly catalog?: string;
}

/** The shape of `globalThis[REGISTRY_KEY]`. Entries keep first-registration order. */
export interface SdkRegistry {
  readonly tools: RegisteredTool[];
  readonly skills: RegisteredSkill[];
  /** First read of each prompt and model id. */
  readonly reads: RegisteredRead[];
}

/** The `globalThis` key of the {@link SdkRegistry}. */
export const REGISTRY_KEY: unique symbol = Symbol.for("ratel.registry.v1") as never;

/** Adds or replaces (by id, in place) a registered tool. */
export function recordTool(entry: RegisteredTool): void {
  upsert(registry().tools, entry);
}

/** Adds or replaces (by id, in place) a registered skill. */
export function recordSkill(entry: RegisteredSkill): void {
  upsert(registry().skills, entry);
}

/** Adds the first read of a prompt or model id. Later reads of the same id keep the first. */
export function recordRead(entry: RegisteredRead): void {
  const reads = registry().reads;
  if (!reads.some((r) => r.kind === entry.kind && r.id === entry.id)) reads.push(entry);
}

function registry(): SdkRegistry {
  const slot = globalThis as { [REGISTRY_KEY]?: Partial<SdkRegistry> };
  const found = slot[REGISTRY_KEY] ?? {};
  if (found.tools && found.skills && found.reads) return found as SdkRegistry;
  // Fill what an older copy of this package left out, keeping its arrays.
  const full: SdkRegistry = {
    tools: found.tools ?? [],
    skills: found.skills ?? [],
    reads: found.reads ?? [],
  };
  slot[REGISTRY_KEY] = full;
  return full;
}

function upsert<T extends { readonly id: string }>(list: T[], entry: T): void {
  const at = list.findIndex((item) => item.id === entry.id);
  if (at === -1) list.push(entry);
  else list[at] = entry;
}
