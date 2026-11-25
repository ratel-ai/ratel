"use server";

import { revalidatePath } from "next/cache";
import { focusedConsoleEnabled } from "@/lib/console/focused-console";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import { changeOverviewLayout, LAYOUT_REFUSALS } from "@/lib/views/overview-layout/actions";
import type { OverviewLayout } from "@/lib/views/overview-layout/domain/layout";
import { webLayoutDeps } from "@/lib/views/overview-layout/readers";

const logger = getLogger("overview-layout/actions");

export type OverviewLayoutActionResult =
  | { ok: true; layout: OverviewLayout }
  | { ok: false; message: string };

/**
 * Change the signed-in person's Overview layout of one project. The project and the person are
 * resolved here; the client posts the project id and the change only.
 */
export async function saveOverviewLayout(
  projectId: string,
  change: unknown,
): Promise<OverviewLayoutActionResult> {
  const scope =
    typeof projectId === "string" && isDbConfigured() ? await findProjectScope(projectId) : null;
  if (!scope || !(await focusedConsoleEnabled(scope.organization)))
    return { ok: false, message: LAYOUT_REFUSALS.not_found };
  try {
    const result = await changeOverviewLayout(scope.project.id, change, webLayoutDeps);
    if (!result.ok) return { ok: false, message: LAYOUT_REFUSALS[result.reason] };
    // The page then reads what a widget just added needs, and Back shows this layout.
    revalidatePath(`/project/${scope.project.id}`);
    return result;
  } catch (err) {
    logger.error({ err, project_id: scope.project.id }, "overview layout change failed");
    reportServerException(err, scope.user.externalId, {
      project_id: scope.project.id,
      operation: "overview_layout_change",
    });
    return { ok: false, message: "Try again." };
  }
}
