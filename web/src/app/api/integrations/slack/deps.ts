import { getConfig } from "@/config";
import { composition } from "@/lib/composition/ports";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { secretBoxConfigured } from "@/lib/platform/secret-box";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { slackCaller } from "@/lib/views/slack/api";
import { slackAppOf, slackRedirectUrl } from "@/lib/views/slack/app";
import type { InstallDeps } from "@/lib/views/slack/install";
import { getSlackConnection, saveSlackConnection } from "@/lib/views/slack/store";

const logger = getLogger("slack/install");

export function installDeps(): InstallDeps {
  const slackUrl = getConfig().slack.url;
  return {
    getSession: getSessionContext,
    findProjectScope: (projectId) => findProjectScope(projectId),
    isRestricted: isRestrictedBySupportSession,
    role: async (projectId) => (await findProjectScope(projectId))?.role ?? null,
    app: (organizationId) => slackAppOf(organizationId),
    connection: (organizationId) => getSlackConnection(organizationId),
    editionOwned: composition.slackApp !== undefined,
    canSeal: secretBoxConfigured,
    call: slackCaller(slackUrl),
    save: (connection) => saveSlackConnection(connection),
    observe: async (fields) => {
      logger.info(fields, "slack_install_finished");
      await trackServerEvent(
        "feature.slack.install_finished",
        { externalId: fields.actor, projectId: fields.project_id, orgId: fields.organization_id },
        fields,
      );
    },
    redirectUrl: slackRedirectUrl(),
    slackUrl,
  };
}

/** Never stored, and the address with the code is never a referrer. */
export function respond(status: number, body: string | null, location?: string): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      ...(location ? { location } : {}),
    },
  });
}

/** Catches everything: an error that reached Next would be reported with the request's query. */
export async function guarded(work: () => Promise<Response>): Promise<Response> {
  if (!isDbConfigured()) return respond(503, "No database is connected.");
  try {
    return await work();
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.name : "unknown" },
      "slack install failed",
    );
    return respond(500, "The Slack install failed. Try again.");
  }
}
