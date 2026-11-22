import { z } from "zod";
import { getLogger } from "@/lib/platform/logger";
import type { Organization } from "@/lib/platform/organizations";
import type { Project } from "@/lib/platform/projects/schema";
import {
  type AgentOverride,
  type AgentOverrideChange,
  MAX_DISPLAY_NAME,
  OVERRIDE_REJECTIONS,
} from "./domain/overrides";
import type { AgentOverrideStore } from "./ports/store";

/**
 * `PUT /api/projects/<id>/agents/overrides` (RC-776): rename, hide or merge
 * one detected agent. Only an admin of the project's organization changes
 * overrides; a member reads them.
 */

export interface AgentOverrideApiDeps {
  getSession: () => Promise<{ user: { id: string; externalId: string } } | null>;
  findProjectScope: (
    projectId: string,
    userId: string,
  ) => Promise<{ project: Project; organization: Organization; role: string } | null>;
  /** An admin support session may look but not change. */
  isRestricted: () => Promise<boolean>;
  store: () => AgentOverrideStore;
  track: (event: {
    externalId: string;
    projectId: string;
    organizationId: string;
    change: AgentOverrideChange;
    override: AgentOverride;
  }) => Promise<void>;
}

const logger = getLogger("agents/overrides-api");
const agentKey = z.string().trim().min(1).max(256);
const ChangeBody = z
  .object({
    agentKey,
    displayName: z.string().max(MAX_DISPLAY_NAME).nullable().optional(),
    hidden: z.boolean().optional(),
    mergedInto: agentKey.nullable().optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.displayName !== undefined || body.hidden !== undefined || body.mergedInto !== undefined,
    {
      message: "Change at least one of displayName, hidden or mergedInto.",
    },
  );

export async function handleAgentOverrideChange(
  request: Request,
  projectId: string,
  deps: AgentOverrideApiDeps,
): Promise<Response> {
  const session = await deps.getSession();
  if (!session)
    return json(401, { ok: false, error: "signed_out", message: "Sign in to change agents." });
  const scope = await deps.findProjectScope(projectId, session.user.id);
  if (!scope) {
    return json(404, {
      ok: false,
      error: "not_found",
      message: "No project you belong to has that ID.",
    });
  }
  if (scope.role !== "admin")
    return json(403, {
      ok: false,
      error: "not_admin",
      message: "Only organization admins can change agents.",
    });
  if (await deps.isRestricted())
    return json(403, {
      ok: false,
      error: "restricted",
      message: "A support session cannot change agents.",
    });

  const parsed = ChangeBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return json(400, {
      ok: false,
      error: "invalid",
      message: parsed.error.issues[0]?.message ?? "Invalid change.",
    });
  const change = parsed.data;

  const result = await deps
    .store()
    .changeOverride(scope.project.id, change, session.user.externalId);
  if (!result.ok) {
    logger.info(
      { project_id: scope.project.id, reason: result.reason, outcome: "rejected" },
      "agent override rejected",
    );
    return json(409, {
      ok: false,
      error: result.reason,
      message: OVERRIDE_REJECTIONS[result.reason],
    });
  }
  logger.info({ project_id: scope.project.id, outcome: "saved" }, "agent override changed");
  await deps.track({
    externalId: session.user.externalId,
    projectId: scope.project.id,
    organizationId: scope.organization.id,
    change,
    override: result.override,
  });
  return json(200, { ok: true, override: result.override });
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}
