import type {
  getProjectCatalogVersionV2 as getProjectCatalogVersionV2Fn,
  getPublishedCatalogV2 as getPublishedCatalogV2Fn,
  setProjectCatalogVersionV2 as setProjectCatalogVersionV2Fn,
} from "@/lib/catalog/queries";
import { type Catalog, etagOf, ifNoneMatchMatches, resolve } from "@/lib/catalog/wire-v2";
import type { hashApiKey as hashApiKeyFn } from "@/lib/platform/api-keys";
import type { isDbConfigured as isDbConfiguredFn } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import type {
  findActiveApiKeyByHash as findActiveApiKeyByHashFn,
  touchApiKey as touchApiKeyFn,
} from "@/lib/platform/projects/queries";
import type { setRequestLogContext as setRequestLogContextFn } from "@/lib/platform/request-log";
import { reportServerException } from "@/lib/platform/telemetry";

export interface CatalogV2HandlerDeps {
  isDbConfigured: typeof isDbConfiguredFn;
  hashApiKey: typeof hashApiKeyFn;
  findActiveApiKeyByHash: typeof findActiveApiKeyByHashFn;
  touchApiKey: typeof touchApiKeyFn;
  getProjectCatalogVersionV2: typeof getProjectCatalogVersionV2Fn;
  getPublishedCatalogV2: typeof getPublishedCatalogV2Fn;
  setProjectCatalogVersionV2: typeof setProjectCatalogVersionV2Fn;
  getScopedCatalogV2: (projectId: string, endUserId: string) => Promise<Catalog>;
  setRequestLogContext?: typeof setRequestLogContextFn;
}

const ERROR_STATUS = {
  unauthorized: 401,
  not_found: 404,
  unavailable: 503,
} as const;
type ErrorCode = keyof typeof ERROR_STATUS;

const logger = getLogger("catalog/pull-v2");

export async function handleCatalogV2Request(
  req: Request,
  deps: CatalogV2HandlerDeps,
): Promise<Response> {
  const authz = req.headers.get("authorization") ?? "";
  const match = authz.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return fail("unauthorized", "Missing or malformed Authorization: Bearer <key>.");
  }

  if (!deps.isDbConfigured()) {
    return fail("unavailable", "Catalog is not available. Database not configured.");
  }

  const apiKey = await deps.findActiveApiKeyByHash(deps.hashApiKey(match[1].trim()));
  if (!apiKey) return fail("unauthorized", "Invalid or revoked API key.");

  deps.setRequestLogContext?.(req, { project_id: apiKey.projectId });

  const scope = new URL(req.url).searchParams.get("scope")?.trim() || null;
  const inm = req.headers.get("if-none-match");

  if (scope !== null) {
    const catalog = await deps.getScopedCatalogV2(apiKey.projectId, scope);
    const resolved = resolve(catalog, scope);
    const { hex, etag } = etagOf(resolved);
    await touchApiKeyBestEffort(deps, apiKey.id, apiKey.projectId);
    const headers = responseHeaders(etag);
    if (ifNoneMatchMatches(inm, etag)) return new Response(null, { status: 304, headers });
    return Response.json({ catalogVersion: hex, skills: resolved }, { headers });
  }

  // Unlike v1, null cannot stand for the empty-set hash: this column is added by
  // migration to projects that may already have published skills. The first v2
  // read therefore loads and self-heals instead of risking a false empty 304.
  const stored = await deps.getProjectCatalogVersionV2(apiKey.projectId);
  if (stored !== null) {
    const storedEtag = `"${stored}"`;
    if (ifNoneMatchMatches(inm, storedEtag)) {
      await touchApiKeyBestEffort(deps, apiKey.id, apiKey.projectId);
      return new Response(null, { status: 304, headers: responseHeaders(storedEtag) });
    }
  }

  const published = await deps.getPublishedCatalogV2(apiKey.projectId);
  const resolved = resolve({ global: published }, null);
  const { hex, etag } = etagOf(resolved);
  if (hex !== stored) {
    await healVersionBestEffort(deps, apiKey.projectId, hex);
  }
  await touchApiKeyBestEffort(deps, apiKey.id, apiKey.projectId);

  const headers = responseHeaders(etag);
  if (ifNoneMatchMatches(inm, etag)) return new Response(null, { status: 304, headers });
  return Response.json({ catalogVersion: hex, skills: resolved }, { headers });
}

function fail(code: ErrorCode, message: string): Response {
  return Response.json({ error: { code, message } }, { status: ERROR_STATUS[code] });
}

function responseHeaders(etag: string): { ETag: string; "Cache-Control": string } {
  return { ETag: etag, "Cache-Control": "no-cache" };
}

async function touchApiKeyBestEffort(
  deps: CatalogV2HandlerDeps,
  apiKeyId: string,
  projectId: string,
): Promise<void> {
  try {
    await deps.touchApiKey(apiKeyId);
  } catch (error) {
    reportBackgroundError(error, projectId, "catalog api key heartbeat failed");
  }
}

async function healVersionBestEffort(
  deps: CatalogV2HandlerDeps,
  projectId: string,
  version: string,
): Promise<void> {
  try {
    await deps.setProjectCatalogVersionV2(projectId, version);
  } catch (error) {
    reportBackgroundError(error, projectId, "catalog version self-heal failed");
  }
}

function reportBackgroundError(error: unknown, projectId: string, message: string): void {
  logger.error({ err: error, project_id: projectId }, message);
  reportServerException(error, `project:${projectId}`, {
    module: "catalog/pull-v2",
    project_id: projectId,
  });
}
