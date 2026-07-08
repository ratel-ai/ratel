/**
 * `@ratel-ai/cloud` — pull-sync loader for a networked catalog source over the
 * frozen protocol/v1 contract. `createSkillSync` attaches a source to a
 * `SkillCatalog` and returns the running handle; `syncSkills` is the one-shot
 * variant. Configuration resolves from explicit options over `RATEL_URL` /
 * `RATEL_API_KEY` (ADR-0003).
 */

import { resolveSourceConfig, type SkillCatalog } from "@ratel-ai/sdk";
import { CloudConfigError } from "./errors.js";
import { SkillSync, type SkillSyncOptions, type SyncResult } from "./skill-sync.js";

export type { CatalogSkillWire, SkillLike, SourceLayers } from "./canonical.js";
export {
  canonicalSet,
  canonicalSkill,
  etagOf,
  projectSkill,
  resolveScope,
  skillsEqual,
} from "./canonical.js";
export {
  CloudApiError,
  CloudAuthError,
  CloudConfigError,
  CloudUnavailableError,
} from "./errors.js";
export type { CatalogResponse, FetchCatalogOptions, FetchCatalogResult } from "./fetch-catalog.js";
export { fetchCatalog } from "./fetch-catalog.js";
export type { SkillSyncOptions, SyncResult } from "./skill-sync.js";
export { SkillSync } from "./skill-sync.js";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface SyncSkillsOptions {
  /** Base URL of the catalog source; falls back to `RATEL_URL`. */
  url?: string;
  /** Bearer key for every `/v1` request; falls back to `RATEL_API_KEY`. */
  apiKey?: string;
  /** Opaque subject selector, passed through as `?scope=`. Fixed per loader. */
  scope?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export interface CreateSkillSyncOptions extends SyncSkillsOptions {
  /** Refresh cadence of the periodic chain (default 5 minutes, ±10% jitter). */
  intervalMs?: number;
}

/** The running loader returned by {@link createSkillSync}. */
export type SkillSyncHandle = SkillSync;

function requireConfig(options: SyncSkillsOptions) {
  const config = resolveSourceConfig(options, options.env);
  if (config === undefined) {
    throw new CloudConfigError("no catalog source configured: pass `url` or set RATEL_URL");
  }
  return config;
}

function syncOptions(options: SyncSkillsOptions): SkillSyncOptions {
  return options.fetchImpl ? { fetchImpl: options.fetchImpl } : {};
}

/**
 * Attach a catalog source to `catalog` and return the running handle: an
 * immediate first refresh plus the periodic chain. Offline-tolerant — a failed
 * first fetch surfaces on the handle (`consecutiveFailures`, `lastSyncedAt`)
 * instead of throwing; only an unresolvable configuration throws.
 */
export function createSkillSync(
  catalog: SkillCatalog,
  options: CreateSkillSyncOptions = {},
): SkillSyncHandle {
  const config = requireConfig(options);
  const sync = new SkillSync(catalog, config, syncOptions(options));
  sync.refresh().catch(() => {
    // Surfaced via `consecutiveFailures`; the chain retries.
  });
  sync.start(options.intervalMs ?? DEFAULT_INTERVAL_MS);
  return sync;
}

/** One-shot sync of `catalog` from the source. Throws on any failure. */
export async function syncSkills(
  catalog: SkillCatalog,
  options: SyncSkillsOptions = {},
): Promise<SyncResult> {
  const config = requireConfig(options);
  const sync = new SkillSync(catalog, config, syncOptions(options));
  return sync.refresh();
}
