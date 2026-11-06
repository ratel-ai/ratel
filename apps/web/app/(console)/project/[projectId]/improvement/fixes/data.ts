import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import type { Organization } from "@/lib/platform/organizations";
import { reportServerException } from "@/lib/platform/telemetry";
import { evalGateEnabledFor } from "@/lib/views/eval-gate/gate";
import { listEvalBadges } from "@/lib/views/eval-gate/service";
import type { EvalBadge } from "@/lib/views/eval-gate/types";
import { loadFixes } from "@/lib/views/fixes/load";
import { listProjectShipments } from "@/lib/views/fixes/loop-queries";
import { type FixShipped, shippedByFix } from "@/lib/views/fixes/shipped";
import type { FixesModel } from "@/lib/views/fixes/types";
import type { SectionProgress } from "@/lib/views/freshness/model";
import { loadPageProgress } from "@/lib/views/freshness/page";
import { stageSpineEnabled } from "@/lib/views/stage-spine-flag";

export type FixesPageData =
  | { kind: "no-db" }
  | {
      kind: "ready";
      projectId: string;
      model: FixesModel;
      now: string;
      /** Each fix's eval gate badge, by fix id; null when `FF_EVAL_GATE` is off. */
      evalBadges: Record<string, EvalBadge> | null;
      /** Each shipped fix's newest shipment, by fix id; null when `FF_STAGE_SPINE` is off. */
      shipped: Record<string, FixShipped> | null;
      /** Where the jobs that find fixes stand; null when the read failed. */
      progress: SectionProgress | null;
    };

const logger = getLogger("fixes/data");

/**
 * What Fixes reads: the scope, then every source of fixes (`loadFixes`,
 * where each one degrades on its own). On for every project: no flag.
 * Owned (ADR-0030): the project comes from the console scope, a 404 otherwise.
 */
export async function loadFixesPage(projectId: string): Promise<FixesPageData> {
  if (!isDbConfigured()) return { kind: "no-db" };
  const { project, organization, user } = await requireProjectScope(projectId);
  const now = new Date();
  const [model, evalBadges, shipped, progress] = await Promise.all([
    loadFixes({ projectId: project.id, organization, now }),
    loadEvalBadges(project.id, organization, user.externalId),
    loadShipped(project.id, user.externalId),
    loadPageProgress(project.id, "fixes"),
  ]);
  return {
    kind: "ready",
    projectId: project.id,
    model,
    now: now.toISOString(),
    evalBadges,
    shipped,
    progress,
  };
}

/**
 * Which fixes shipped (RC-72, `fix_shipments` rows `mark_fix_shipped` wrote),
 * behind `FF_STAGE_SPINE` with the rest of Ship (null when off). A failed
 * read costs the marks, never the page: every fix then reads as before.
 */
async function loadShipped(
  projectId: string,
  externalId: string,
): Promise<Record<string, FixShipped> | null> {
  if (!stageSpineEnabled()) return null;
  try {
    return shippedByFix(projectId, await listProjectShipments(projectId));
  } catch (err) {
    logger.error({ err, project_id: projectId }, "fix shipments read failed");
    reportServerException(err, externalId, { project_id: projectId, operation: "fix_shipments" });
    return {};
  }
}

/**
 * The eval gate's badges, behind `FF_EVAL_GATE` (null when off). A failed
 * read costs the badges, never the page: every fix then reads "Not simulated".
 */
async function loadEvalBadges(
  projectId: string,
  organization: Organization,
  externalId: string,
): Promise<Record<string, EvalBadge> | null> {
  if (!(await evalGateEnabledFor(organization))) return null;
  try {
    return await listEvalBadges(projectId);
  } catch (err) {
    logger.error({ err, project_id: projectId }, "fix eval badges read failed");
    reportServerException(err, externalId, {
      project_id: projectId,
      operation: "fix_eval_badges",
    });
    return {};
  }
}
