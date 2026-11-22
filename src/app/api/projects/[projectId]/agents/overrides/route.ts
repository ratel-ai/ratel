import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { withRequestLog } from "@/lib/platform/request-log";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { createDrizzleAgentOverrideStore } from "@/lib/views/agents/adapters/drizzle-store";
import { handleAgentOverrideChange } from "@/lib/views/agents/overrides-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Rename, hide or merge one detected agent (RC-776). Admin-only; the logic is in `lib/agents/overrides-api.ts`. */
export const PUT = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string }> }) => {
    if (!isDbConfigured()) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    const { projectId } = await context.params;
    return handleAgentOverrideChange(request, projectId, {
      getSession: getSessionContext,
      findProjectScope,
      isRestricted: isRestrictedBySupportSession,
      store: () => createDrizzleAgentOverrideStore(getDb()),
      track: ({ externalId, projectId: id, organizationId, change, override }) =>
        trackServerEvent(
          "agent_override_updated",
          { externalId, projectId: id, orgId: organizationId },
          {
            object_action: "agent_override_updated",
            renamed: change.displayName !== undefined,
            hidden: override.hidden,
            merged: override.mergedInto !== null,
            surface: "console",
          },
        ),
    });
  },
);
