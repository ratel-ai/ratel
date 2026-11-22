import { z } from "zod";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A UUID, validated as strictly as `z.string().uuid()` but published as a
 * 36-character string. zod's own check publishes a 170-character regex, and
 * with one or two ids on each of 90 tools that regex alone was about 4k tokens
 * of every prompt the tool list rides in. Dispatch re-validates every call
 * against this schema, so a malformed id is still refused.
 */
export function uuidParam() {
  return z
    .string()
    .length(36)
    .refine((value) => UUID.test(value), "Must be a UUID.");
}

/**
 * Parameter fragments shared across operations.
 *
 * `projectId` is present on every project- and organization-scoped operation
 * even though an API key already implies one. That is deliberate: an OAuth
 * caller (MCP-7) reaches many projects and must name the target, so declaring
 * it now means the tool contract does not change when OAuth ships. For API-key
 * callers dispatch fills it in, and a mismatched value is refused rather than
 * silently redirected.
 */
export const projectIdParam = uuidParam()
  .optional()
  .describe("Project id. Optional with a project API key, which implies it.");

export const endUserIdParam = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe("Restrict to a single end user id, when the project segments by one.");

/** Every project-scoped operation starts from this shape. */
export const projectScoped = { projectId: projectIdParam };
