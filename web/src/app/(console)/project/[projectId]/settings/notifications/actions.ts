"use server";

import { revalidatePath } from "next/cache";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { trackServerEvent } from "@/lib/platform/telemetry";
import type { AlertAccessDeps } from "@/lib/views/alerts/actions";
import { listChannels, revokeToken } from "@/lib/views/slack/channels";
import {
  type ChannelsResult,
  disconnectSlack,
  readChannels,
} from "@/lib/views/slack/connection-actions";
import { deleteSlackConnection } from "@/lib/views/slack/store";
import { slackWorkspace } from "@/lib/views/slack/workspace";

const logger = getLogger("slack/connection");

const access: AlertAccessDeps = {
  getSession: getSessionContext,
  findProjectScope: (projectId) => findProjectScope(projectId),
  isRestricted: isRestrictedBySupportSession,
};

/** The channels to pick from. */
export async function slackChannelsAction(projectId: string): Promise<ChannelsResult> {
  return guarded("The channels could not be read. Try again.", () =>
    readChannels(projectId, {
      ...access,
      list: (organizationId) => listChannels(organizationId, slackWorkspace()),
    }),
  );
}

/** Forget the workspace, for every project of the organization. */
export async function disconnectSlackAction(
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return guarded("Slack could not be disconnected. Try again.", () =>
    disconnectSlack(projectId, {
      ...access,
      role: async (id) => (await findProjectScope(id))?.role ?? null,
      revoke: (organizationId) => revokeToken(organizationId, slackWorkspace()),
      remove: (organizationId) => deleteSlackConnection(organizationId),
      observe: async (fields) => {
        logger.info(fields, "slack_disconnected");
        await trackServerEvent(
          "feature.slack.disconnected",
          { externalId: fields.actor, projectId: fields.project_id, orgId: fields.organization_id },
          fields,
        );
        revalidatePath("/project", "layout");
      },
    }),
  );
}

async function guarded<T>(
  error: string,
  work: () => Promise<T>,
): Promise<T | { ok: false; error: string }> {
  if (!isDbConfigured()) return { ok: false, error: "No database is connected." };
  try {
    return await work();
  } catch (err) {
    // The type only: a database error repeats the row it was given.
    logger.error({ error: err instanceof Error ? err.name : "unknown" }, "slack action failed");
    return { ok: false, error };
  }
}
