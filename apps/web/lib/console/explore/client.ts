import type { SerializedSkill } from "@/lib/catalog/http";
import type { CreateSkillBody, EditSkillBody } from "./forms";

/**
 * The single client-side write seam for the Explore page: thin typed wrappers over
 * the EXISTING account-authed REST routes (session-cookie auth is automatic on
 * same-origin fetch). Every call returns a discriminated result so the browsers can
 * `router.refresh()` on success and show `explainMutationError` on failure.
 */

export type MutationResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; reason?: string; error?: string };

async function send<T>(url: string, method: string, body?: unknown): Promise<MutationResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, status: 0, error: "Network error." };
  }
  const json = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { reason?: string; error?: string })
    | null;
  if (!res.ok) {
    return { ok: false, status: res.status, reason: json?.reason, error: json?.error };
  }
  return { ok: true, data: json as T };
}

/* — Skills catalog CRUD ————————————————————————————————————————————————————————— */

export function createSkill(body: CreateSkillBody): Promise<MutationResult<SerializedSkill>> {
  return send<SerializedSkill>("/api/skills-catalog", "POST", body);
}

export function editSkill(
  id: string,
  body: EditSkillBody,
): Promise<MutationResult<SerializedSkill>> {
  return send<SerializedSkill>(`/api/skills-catalog/${id}`, "PATCH", body);
}

/** Publish or archive ("delete" — there is no DELETE) a skill, guarded by version. */
export function setSkillStatus(
  id: string,
  action: "publish" | "archive",
  expectedVersion: number,
): Promise<MutationResult<SerializedSkill>> {
  return send<SerializedSkill>(`/api/skills-catalog/${id}/${action}`, "POST", { expectedVersion });
}
