"use server";

import { revalidatePath } from "next/cache";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { projectSettingsRoot } from "@/lib/console/settings/tabs";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { secretBoxConfigured } from "@/lib/platform/secret-box";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { reportServerException, trackServerEvent } from "@/lib/platform/telemetry";
import type { MetricResult } from "@/lib/synthesis/metrics/query";
import {
  type AlertAccessDeps,
  type AlertActionInput,
  type AlertActionResult,
  changeAlert,
} from "@/lib/views/alerts/actions";
import {
  changeDestination,
  type DestinationActionInput,
  type DestinationActionResult,
} from "@/lib/views/alerts/destination-actions";
import {
  countDestinations,
  createChannelDestination,
  createDestination,
  deleteDestination,
  sealedDestination,
} from "@/lib/views/alerts/destinations";
import { alertsHref } from "@/lib/views/alerts/links";
import { parseAlertQuery } from "@/lib/views/alerts/parse-rule";
import { loadAlertPreview } from "@/lib/views/alerts/preview";
import { postTo } from "@/lib/views/alerts/slack";
import * as store from "@/lib/views/alerts/store";
import { ALERT_WINDOWS, type AlertWindow } from "@/lib/views/alerts/types";
import { channelAccess } from "@/lib/views/slack/channels";
import { slackWorkspace } from "@/lib/views/slack/workspace";

const logger = getLogger("alerts/actions");

const access: AlertAccessDeps = {
  getSession: getSessionContext,
  findProjectScope: (projectId) => findProjectScope(projectId),
  isRestricted: isRestrictedBySupportSession,
};

/** Create, edit, pause or delete an alert. */
export async function changeAlertAction(input: AlertActionInput): Promise<AlertActionResult> {
  return guarded("alert_change", "Could not save the alert. Try again.", () =>
    changeAlert(input, {
      ...access,
      store,
      observe: async (fields) => {
        logger.info(fields, "alert_changed");
        await trackServerEvent(
          "feature.alerts.changed",
          { externalId: fields.actor, projectId: fields.project_id, orgId: fields.organization_id },
          fields,
        );
        revalidatePath(alertsHref(fields.project_id), "layout");
      },
    }),
  );
}

/** Add, test or remove a Slack destination. The answer never holds a secret. */
export async function changeDestinationAction(
  input: DestinationActionInput,
): Promise<DestinationActionResult> {
  return guarded("alert_destination", "Could not change the destination. Try again.", () =>
    changeDestination(input, {
      ...access,
      canSeal: secretBoxConfigured,
      count: (projectId) => countDestinations(projectId),
      create: (destination) => createDestination(destination),
      channelAccess: (organizationId, channelId) =>
        channelAccess(organizationId, channelId, slackWorkspace()),
      createChannel: (destination) => createChannelDestination(destination),
      remove: (projectId, id) => deleteDestination(projectId, id),
      sealed: (projectId, id) => sealedDestination(projectId, id),
      post: (destination, message) => postTo(destination, message),
      projectName: async (projectId) => (await findProjectScope(projectId))?.project.name ?? "",
      observe: async (fields) => {
        logger.info(fields, "alert_destination_changed");
        await trackServerEvent(
          "feature.alerts.destination_changed",
          { externalId: fields.actor, projectId: fields.project_id, orgId: fields.organization_id },
          fields,
        );
        revalidatePath(projectSettingsRoot(fields.project_id), "layout");
        revalidatePath(alertsHref(fields.project_id), "layout");
      },
    }),
  );
}

export type AlertPreview = { ok: true; result: MetricResult } | { ok: false; error: string };

/** The form's chart: the last 7 days of what the alert would measure. */
export async function previewAlertAction(
  projectId: string,
  rawQuery: unknown,
  windowMinutes: AlertWindow,
): Promise<AlertPreview> {
  return guarded("alert_preview", "The numbers could not be read.", async () => {
    const scope = await findProjectScope(projectId);
    if (!scope) return { ok: false, error: "You cannot read this project." };
    const parsed = parseAlertQuery(rawQuery);
    if (!parsed.ok) return parsed;
    if (!ALERT_WINDOWS.includes(windowMinutes))
      return { ok: false, error: "The alert settings are invalid." };
    const result = await loadAlertPreview(scope.project.id, parsed.query, windowMinutes);
    return result ? { ok: true, result } : { ok: false, error: "The numbers could not be read." };
  });
}

async function guarded<T>(
  operation: string,
  error: string,
  work: () => Promise<T>,
): Promise<T | { ok: false; error: string }> {
  if (!isDbConfigured()) return { ok: false, error: "No database is connected." };
  try {
    return await work();
  } catch (err) {
    logger.error({ err, operation }, "alert action failed");
    reportServerException(err, "system:alerts", { operation });
    return { ok: false, error };
  }
}
