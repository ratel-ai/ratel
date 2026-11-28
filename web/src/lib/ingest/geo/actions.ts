import type { GeoAttributes } from "@/lib/ingest/geo/attributes";
import { parseGeoAttributes } from "@/lib/ingest/geo/parse-attributes";

export interface GeoActionDeps {
  findProjectScope(projectId: string): Promise<{
    project: { id: string };
    organization: { id: string };
    role: string | null;
  } | null>;
  /** An admin support session may look but not change. */
  isRestricted(): Promise<boolean>;
  save(projectId: string, attributes: GeoAttributes): Promise<void>;
  observe(fields: {
    project_id: string;
    organization_id: string;
    field: "geo_attributes";
  }): Promise<void>;
}

/** Change the attributes a project's locations are read from: an admin, outside a support session. */
export async function changeGeoAttributes(
  projectId: string,
  raw: unknown,
  deps: GeoActionDeps,
): Promise<{ ok: true; attributes: GeoAttributes } | { ok: false; error: string }> {
  const scope = await deps.findProjectScope(projectId);
  if (!scope || scope.role !== "admin")
    return { ok: false, error: "Only organization admins can change the location attributes." };
  if (await deps.isRestricted())
    return { ok: false, error: "A support session cannot change settings." };
  const parsed = parseGeoAttributes(raw);
  if (!parsed.ok) return parsed;
  await deps.save(scope.project.id, parsed.attributes);
  await deps.observe({
    project_id: scope.project.id,
    organization_id: scope.organization.id,
    field: "geo_attributes",
  });
  return parsed;
}
