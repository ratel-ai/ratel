import { z } from "zod";
import type { resolveProjectById } from "@/lib/catalog/http";
import { MAX_DESCRIPTION } from "@/lib/catalog/manage";
import type { setRuntimeCatalogOverride } from "@/lib/ingest/runtime-catalog/override-queries";
import type { getOrganizationByProjectId } from "@/lib/platform/organizations";
import type { setRequestLogContext } from "@/lib/platform/request-log";
import type { trackServerEvent } from "@/lib/platform/telemetry";
import type { RuntimeCatalogOverridesGetDeps } from "./overrides-get-handler";

export type RuntimeCatalogKind = "tool" | "skill" | "fact";

/** The session-authenticated operator edit. No API key reaches it. */
export interface RuntimeCatalogOverridePatchDeps {
  resolveProjectById: typeof resolveProjectById;
  getOrganizationByProjectId: typeof getOrganizationByProjectId;
  setRuntimeCatalogOverride: typeof setRuntimeCatalogOverride;
  setRequestLogContext: typeof setRequestLogContext;
  trackServerEvent: typeof trackServerEvent;
}

export {
  handleRuntimeCatalogOverridesGet,
  type RuntimeCatalogOverridesGetDeps,
} from "./overrides-get-handler";

export type RuntimeCatalogOverrideHandlerDeps = RuntimeCatalogOverridePatchDeps &
  RuntimeCatalogOverridesGetDeps;

const runtimeCatalogKind = z.enum(["tool", "skill", "fact"]);
const patchInput = z.object({
  searchableDescription: z.string().max(MAX_DESCRIPTION).nullable(),
});

/** Session-authenticated operator edit for one already-ingested runtime entry. */
export async function handleRuntimeCatalogOverridePatch(
  request: Request,
  params: { kind: string; entryId: string },
  deps: RuntimeCatalogOverridePatchDeps,
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
