/**
 * Catalog-source configuration seam (ADR-0003). A source is a remote catalog
 * a loader pulls skills from over the frozen protocol/v1 contract; resolution
 * here only decides *whether* a source is configured and with what
 * credentials — no loader is selected, no network is touched. Pure and
 * env-injectable, modeled on `resolveOtlpConfig` in `@ratel-ai/telemetry`.
 */

// The package compiles without node type definitions; this module-local
// declaration types the single `process.env` read (node >= 20 per `engines`).
declare const process: { env: Record<string, string | undefined> };

/** Env var naming the catalog source's base URL. Unset = the embedded floor. */
export const SOURCE_URL_ENV = "RATEL_URL";

/** Env var holding the source API key, sent as `Authorization: Bearer <key>`. */
export const SOURCE_API_KEY_ENV = "RATEL_API_KEY";

export interface CatalogSourceConfig {
  /** Base URL of the catalog source (the loader appends `/v1/catalog`). */
  url: string;
  /** API key for `Authorization: Bearer <key>` on every `/v1` request. */
  apiKey?: string;
  /** Opaque subject selector, passed through as `?scope=`. Fixed per loader. */
  scope?: string;
}

/**
 * Resolve explicit options + env into a source config, or `undefined` when no
 * URL is available anywhere — the permanent offline floor: in-process
 * registration only, byte-identical to a build with no source code paths.
 * Explicit options beat env; `scope` comes from options only.
 */
export function resolveSourceConfig(
  options?: { url?: string; apiKey?: string; scope?: string },
  env: Record<string, string | undefined> = process.env,
): CatalogSourceConfig | undefined {
  const url = options?.url ?? env[SOURCE_URL_ENV];
  if (!url) return undefined;
  const config: CatalogSourceConfig = { url };
  const apiKey = options?.apiKey ?? env[SOURCE_API_KEY_ENV];
  if (apiKey !== undefined) config.apiKey = apiKey;
  if (options?.scope !== undefined) config.scope = options.scope;
  return config;
}
