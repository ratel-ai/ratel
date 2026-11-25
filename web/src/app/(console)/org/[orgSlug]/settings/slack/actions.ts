"use server";

import { revalidatePath } from "next/cache";
import { organizationSettingsRoot } from "@/lib/console/settings/tabs";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { secretBoxConfigured } from "@/lib/platform/secret-box";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { trackServerEvent } from "@/lib/platform/telemetry";
import {
  changeSlackApp,
  type SlackAppInput,
  type SlackAppResult,
} from "@/lib/views/slack/app-actions";
import { deleteSlackApp, saveSlackApp } from "@/lib/views/slack/store";
import { slackAppAccess } from "./access";

const logger = getLogger("slack/app");

/** Save or remove the organization's Slack app. The answer never holds its secret. */
export async function changeSlackAppAction(input: SlackAppInput): Promise<SlackAppResult> {
  if (!isDbConfigured()) return { ok: false, error: "No database is connected." };
  try {
    return await changeSlackApp(input, {
      ...slackAppAccess,
      isRestricted: isRestrictedBySupportSession,
      canSeal: secretBoxConfigured,
      save: (app) => saveSlackApp(app),
      remove: (organizationId) => deleteSlackApp(organizationId),
      observe: async (fields) => {
        logger.info(fields, "slack_app_changed");
        await trackServerEvent(
          "feature.slack.app_changed",
          { externalId: fields.actor, orgId: fields.organization_id },
          fields,
        );
        revalidatePath(organizationSettingsRoot(input.orgSlug), "layout");
      },
    });
  } catch (error) {
    // The type only: a database error repeats the row it was given.
    logger.error({ error: error instanceof Error ? error.name : "unknown" }, "slack app not saved");
    return { ok: false, error: "Could not save the Slack app. Try again." };
  }
}
