import type { QuotaKey } from "@/lib/platform/entitlements";

/**
 * Error bodies for the Bearer-authed `/api/v1/*` surfaces.
 *
 * The dashboard routes put a display-ready sentence in `error` (see
 * `mutationErrorResponse` in lib/catalog/http.ts);
 * the SDK contract is the opposite: `error` is a machine code (it becomes
 * `CloudSdkError.code` in `@ratel-ai/cloud-sdk`) and `reason` an optional
 * finer-grained code appended to the thrown message. The shapes here mirror
 * the SDK's mock server (mock-cloud.ts), which ADR-0014 makes the
 * authoritative wire contract — keep the two in lockstep.
 */

/** The mutation-failure reasons of the v1 write surfaces (`SkillMutationResult`). */
export type V1MutationReason = "not_found" | "version_conflict" | "name_conflict";

export function v1MutationErrorResponse(reason: V1MutationReason): Response {
  if (reason === "not_found") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  // version_conflict | name_conflict: both state conflicts.
  return Response.json({ error: "conflict", reason }, { status: 409 });
}

/** Plan-limit rejection: `reason` is the quota key, `message` display-ready
 * (from `checkQuota`). The SDK maps `quota_exceeded` as a first-class code. */
export function v1QuotaExceededResponse(reason: QuotaKey, message: string): Response {
  return Response.json({ error: "quota_exceeded", reason, message }, { status: 403 });
}

/** A retired endpoint: `410 { error: "endpoint_removed", message }`. The code is
 * stable so a client can tell "removed" from "not found"; `message` says when. */
export function v1EndpointRemovedResponse(message: string): Response {
  return Response.json({ error: "endpoint_removed", message }, { status: 410 });
}
