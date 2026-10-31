import { createHash } from "node:crypto";
import { z } from "zod";
import type { resolveProjectById } from "@/lib/catalog/http";
import { MAX_DESCRIPTION } from "@/lib/catalog/manage";
import { ifNoneMatchMatches } from "@/lib/catalog/wire";
import type {
  listRuntimeCatalogOverrides,
  setRuntimeCatalogOverride,
  touchRuntimeCatalogOverridesPull,
} from "@/lib/ingest/runtime-catalog/override-queries";
import type { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import type { getOrganizationByProjectId } from "@/lib/platform/identity/queries";
import { getLogger } from "@/lib/platform/logger";
import type { setRequestLogContext } from "@/lib/platform/request-log";
import type { trackServerEvent } from "@/lib/platform/telemetry";

const overridesLogger = getLogger("runtime-catalog/override-handler");

export type RuntimeCatalogKind = "tool" | "skill" | "fact";

export interface RuntimeCatalogOverrideHandlerDeps {
  resolveProjectById: typeof resolveProjectById;
  resolveProjectFromBearer: typeof resolveProjectFromBearer;
  getOrganizationByProjectId: typeof getOrganizationByProjectId;
  setRuntimeCatalogOverride: typeof setRuntimeCatalogOverride;
  listRuntimeCatalogOverrides: typeof listRuntimeCatalogOverrides;
  touchRuntimeCatalogOverridesPull: typeof touchRuntimeCatalogOverridesPull;
  setRequestLogContext: typeof setRequestLogContext;
  trackServerEvent: typeof trackServerEvent;
}

const runtimeCatalogKind = z.enum(["tool", "skill", "fact"]);
const patchInput = z.object({
  searchableDescription: z.string().max(MAX_DESCRIPTION).nullable(),
});

/** Session-authenticated operator edit for one already-ingested runtime entry. */
export async function handleRuntimeCatalogOverridePatch(
  request: Request,
  params: { kind: string; entryId: string },
  deps: RuntimeCatalogOverrideHandlerDeps,
): Promise<Response> {
  const kind = runtimeCatalogKind.safeParse(params.kind);
  if (!kind.success) {
    return Response.json({ error: "Unknown catalog kind." }, { status: 400 });
  }

  const resolved = await deps.resolveProjectById(new URL(request.url).searchParams.get("project"));
  if (!resolved.ok) return resolved.response;
  deps.setRequestLogContext(request, {
    project_id: resolved.project.id,
    org_id: resolved.accountId,
    distinct_id: resolved.externalId,
  });

  const parsed = patchInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "searchableDescription must be a string or null." },
      { status: 400 },
    );
  }

  const row = await deps.setRuntimeCatalogOverride(
    resolved.project.id,
    kind.data,
    params.entryId,
    parsed.data.searchableDescription,
  );
  if (!row) {
    return Response.json(
      { error: "No ingested runtime definition for this entry." },
      { status: 404 },
    );
  }

  await deps.trackServerEvent(
    "runtime_catalog_override_updated",
    {
      externalId: resolved.externalId,
      orgId: resolved.accountId,
      projectId: resolved.project.id,
    },
    {
      object_action: "runtime_catalog_override_updated",
      kind: kind.data,
      entry_id: params.entryId,
      cleared: parsed.data.searchableDescription === null,
    },
  );
  return Response.json({
    kind: kind.data,
    entryId: params.entryId,
    searchableDescription: row.searchableDescriptionOverride,
  });
}

/** Bearer-authenticated pull view for Cloud-side runtime overrides. */
export async function handleRuntimeCatalogOverridesGet(
  request: Request,
  deps: RuntimeCatalogOverrideHandlerDeps,
): Promise<Response> {
  const resolved = await deps.resolveProjectFromBearer(request);
  if (!resolved.ok) return resolved.response;

  const organization = await deps.getOrganizationByProjectId(resolved.projectId);
  deps.setRequestLogContext(request, {
    project_id: resolved.projectId,
    ...(organization ? { org_id: organization.id } : {}),
  });
  // The pull itself is the only positive evidence that an override we store
  // actually reaches a runtime, so record it before deciding whether to answer
  // 304: a conditional request proves the runtime is listening just as well as
  // a 200, and it is the overwhelmingly common case. Best-effort, because
  // failing to note the visit must never fail the visit.
  try {
    await deps.touchRuntimeCatalogOverridesPull(resolved.projectId);
  } catch (error) {
    overridesLogger.error(
      { err: error, project_id: resolved.projectId },
      "recording the override pull failed",
    );
  }

  const payload = {
    overrides: await deps.listRuntimeCatalogOverrides(resolved.projectId),
  };
  const etag = `"${createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex")}"`;
  const headers = { ETag: etag, "Cache-Control": "no-cache" };
  if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return Response.json(payload, { headers });
}
