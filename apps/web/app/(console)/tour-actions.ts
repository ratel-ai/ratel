"use server";

import { cookies } from "next/headers";
import { recordTourStatus, TOUR_STATUS_COOKIE } from "@/lib/console/onboarding/tour-cookie";
import {
  isOnboardingTourStatus,
  type OnboardingTourStatus,
} from "@/lib/console/onboarding/tour-state";
import { BASE_URL } from "@/lib/platform/app-config";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { getSessionContext } from "@/lib/platform/session";
import { trackProductEvent } from "@/lib/platform/telemetry";

const logger = getLogger("onboarding/tour");

/**
 * Record that the signed-in user finished (or skipped) the guided tour.
 *
 * Owned (ADR-0030): upstream writes `users.onboarding_tour_status`; the users table is the
 * private edition's, so the status is kept in a cookie (`tour-cookie.ts`), written only when it
 * changes. The cookie is `Secure` when this deployment's origin is https, as the last-project
 * cookie is.
 *
 * `status` arrives from the browser, so it is validated here rather than trusted: a server
 * action is a public endpoint.
 */
export async function finishOnboardingTourAction(
  status: OnboardingTourStatus,
  lastStepId: string,
  stepsViewed: number,
): Promise<void> {
  if (!isOnboardingTourStatus(status)) {
    logger.warn({ status }, "rejected unknown onboarding tour status");
    return;
  }
  if (!isDbConfigured()) return;

  const context = await getSessionContext();
  if (!context) return;

  const cookieStore = await cookies();
  recordTourStatus(status, {
    current: () => cookieStore.get(TOUR_STATUS_COOKIE)?.value,
    write: (cookie) => {
      cookieStore.set(cookie.name, cookie.value, cookie.options);
    },
    secure: BASE_URL.startsWith("https://"),
  });
  logger.info(
    {
      userId: context.user.id,
      orgId: context.organization.id,
      status,
      lastStepId,
      stepsViewed,
    },
    "onboarding tour finished",
  );
  await trackProductEvent(
    "onboarding_tour_finished",
    { externalId: context.user.externalId, orgId: context.organization.id },
    {
      outcome: status,
      last_step_id: String(lastStepId).slice(0, 64),
      steps_viewed: Number.isFinite(stepsViewed) ? stepsViewed : 0,
    },
  );
}
