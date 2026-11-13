/**
 * Where a tool or a skill on the Intents pages opens: its row on the Catalog. Owned
 * (ADR-0030): upstream keeps this beside the adaptive-ranking page view, which lands with
 * match quality.
 */
export type CapabilityKind = "tool" | "skill";

/**
 * Tools open the Tools catalog filtered to the id with that row highlighted; skills open the
 * Skills catalog with the record opened when the wire name resolves to a stored skill id.
 */
export function capabilityCatalogHref(
  projectId: string,
  kind: CapabilityKind,
  capabilityId: string,
  skillId: string | null = null,
): string {
  const root = `/project/${encodeURIComponent(projectId)}/catalogs`;
  if (kind === "tool") {
    const q = encodeURIComponent(capabilityId);
    return `${root}/tools?q=${q}&highlight=${q}`;
  }
  return skillId ? `${root}/skills?skill=${encodeURIComponent(skillId)}` : `${root}/skills`;
}
