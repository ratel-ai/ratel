/**
 * One conditional GET of a source's `/v1/catalog`. The single place the loader
 * touches the network; everything above it consumes the discriminated
 * changed/unchanged result.
 */

import type { CatalogSourceConfig } from "@ratel-ai/sdk";
import type { CatalogSkillWire } from "./canonical.js";
import { CloudApiError, CloudUnavailableError, errorFromResponse } from "./errors.js";

/** The 200 body of `GET /v1/catalog` (`catalog-response.schema.json`). */
export interface CatalogResponse {
  catalogVersion: string;
  skills: CatalogSkillWire[];
}

export type FetchCatalogResult =
  | { changed: true; etag: string; catalog: CatalogResponse }
  | { changed: false };

export interface FetchCatalogOptions {
  /** The cached ETag for this `(url, scope)`, sent as `If-None-Match`. */
  etag?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export async function fetchCatalog(
  config: CatalogSourceConfig,
  options: FetchCatalogOptions = {},
): Promise<FetchCatalogResult> {
  const url = new URL(`${config.url.replace(/\/+$/, "")}/v1/catalog`);
  if (config.scope !== undefined) url.searchParams.set("scope", config.scope);

  const headers: Record<string, string> = {};
  if (config.apiKey !== undefined) headers.authorization = `Bearer ${config.apiKey}`;
  if (options.etag !== undefined) headers["if-none-match"] = options.etag;

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), { headers });
  } catch (err) {
    throw new CloudUnavailableError(`catalog source unreachable: ${url.origin}`, { cause: err });
  }

  if (response.status === 304) return { changed: false };
  if (!response.ok) {
    throw errorFromResponse(response.status, await response.text().catch(() => ""));
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CloudApiError("catalog source returned a non-JSON 200 body", response.status);
  }
  const catalog = body as CatalogResponse;
  if (typeof catalog?.catalogVersion !== "string" || !Array.isArray(catalog?.skills)) {
    throw new CloudApiError(
      "catalog source returned an invalid catalog body (catalogVersion/skills)",
      response.status,
    );
  }
  const etag = response.headers.get("etag") ?? `"${catalog.catalogVersion}"`;
  return { changed: true, etag, catalog };
}
