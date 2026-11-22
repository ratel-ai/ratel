import {
  CATALOG_HOST_KEY,
  type CatalogHost,
  type CatalogKind,
  REGISTRY_KEY,
  type SdkRegistry,
} from "../catalog.js";

// What @ratel-ai/sdk does through the global slots, so sandbox tests need no SDK
// dependency: `ratel.prompt/model` (sdkRead), `ratel.toolset` (sdkToolset) and the
// registration of tools on a `ratel()` core (sdkRegisterTools).

function host(): CatalogHost | undefined {
  return (globalThis as { [CATALOG_HOST_KEY]?: CatalogHost })[CATALOG_HOST_KEY];
}

export function sdkRead(kind: CatalogKind, id: string, fallback: string): string {
  const reads = registry().reads ?? [];
  if (!reads.some((r) => r.kind === kind && r.id === id))
    reads.push({ kind, id, default: fallback });
  host()?.record({ kind, id, default: fallback });
  return host()?.resolve(kind, id) ?? fallback;
}

export function sdkToolset<T extends object>(tools: T): T {
  return host()?.toolset?.(tools) ?? tools;
}

export function sdkRegisterTools(tools: Readonly<Record<string, { description: string }>>): void {
  for (const [id, tool] of Object.entries(tools)) {
    const list = registry().tools;
    const at = list.findIndex((t) => t.id === id);
    const entry = { id, description: tool.description, tool };
    if (at === -1) list.push(entry);
    else list[at] = entry;
  }
}

function registry(): SdkRegistry {
  const slot = globalThis as { [REGISTRY_KEY]?: SdkRegistry };
  slot[REGISTRY_KEY] ??= { tools: [], skills: [], reads: [] };
  return slot[REGISTRY_KEY];
}
