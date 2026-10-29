/**
 * The Bearer and session helpers the catalog APIs share. Owned slim surface of
 * the upstream module: serialize and project resolve only. Console session
 * helpers for slug/skill pages stay out until the L6 slice.
 */

export { type ResolvedProject, resolveProjectById } from "@/lib/catalog/resolve-project";
export { type SerializedSkill, serializeSkill } from "@/lib/catalog/serialize";
