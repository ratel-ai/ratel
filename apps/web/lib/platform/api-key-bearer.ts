import { hashApiKey } from "@/lib/platform/api-keys";
import { isDbConfigured } from "@/lib/platform/db/client";
import { findActiveApiKeyByHash, touchApiKey } from "@/lib/platform/projects/queries";

/**
 * Bearer-key auth for the project-key `/api/v1/*` surfaces: hash the presented
 * key, look it up among active keys, and resolve the project it belongs to, so an
 * `@ratel-ai/cloud` host can act on ITS OWN project with no dashboard session.
 */

export type ResolvedApiKeyProject =
  | { ok: true; projectId: string; apiKeyId: string }
  | { ok: false; response: Response };

export async function resolveProjectFromBearer(req: Request): Promise<ResolvedApiKeyProject> {
  const authz = req.headers.get("authorization") ?? "";
  const match = authz.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return {
      ok: false,
      response: Response.json(
        { error: "Missing or malformed Authorization: Bearer <key>." },
        { status: 401 },
      ),
    };
  }
  if (!isDbConfigured()) {
    return {
      ok: false,
      response: Response.json(
        { error: "Not available. Database not configured." },
        { status: 503 },
      ),
    };
  }
  const apiKey = await findActiveApiKeyByHash(hashApiKey(match[1].trim()));
  if (!apiKey) {
    return {
      ok: false,
      response: Response.json({ error: "Invalid or revoked API key." }, { status: 401 }),
    };
  }
  await touchApiKey(apiKey.id);
  return { ok: true, projectId: apiKey.projectId, apiKeyId: apiKey.id };
}
