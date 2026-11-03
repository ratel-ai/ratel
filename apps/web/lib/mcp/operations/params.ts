import { z } from "zod";

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
export const projectIdParam = z
  .string()
  .uuid()
  .optional()
  .describe(
    "Project to act on. Optional when authenticating with a project API key, which implies it.",
  );

export const endUserIdParam = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe("Restrict to a single end user id, when the project segments by one.");

/** Every project-scoped operation starts from this shape. */
export const projectScoped = { projectId: projectIdParam };
