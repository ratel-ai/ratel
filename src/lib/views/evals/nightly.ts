import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { hasPaidPlan, type OrgLimitView } from "@/lib/platform/entitlements";
import { envNumber } from "@/lib/platform/env-number";
import { getLogger } from "@/lib/platform/logger";
import { isAdmin } from "@/lib/platform/organization";
import {
  defaultOrganizationFlagDeps,
  type OrganizationFlagDeps,
} from "@/lib/platform/organization-flags";
import { projects } from "@/lib/platform/projects/schema";
import { evalNightlySettings, evalRuns } from "@/lib/views/evals/schema";
import { EVALS_OFF_ERROR, evalsEnabledForActor } from "./gate";
import { organizationPaid } from "./job";
import { type ActionResult, queueEvalRun } from "./run";

/**
 * RC-299: nightly runs of the eval set. Off by default (no settings row). Only
 * an admin of an organization on a paid plan can turn them on, and the drain
 * sweep checks the plan again, so a project that leaves the paid plan gets no
 * more runs. One run per project per UTC day, held to `NIGHTLY_EVAL_BUDGET_USD`
 * and to what the organization has left of its daily budget.
 */

export interface NightlySetting {
  enabled: boolean;
  setBy: string | null;
  setAt: Date | null;
}

export interface SetNightlyDeps {
  db?: ReturnType<typeof getDb>;
  flagDeps?: OrganizationFlagDeps;
  now?: () => Date;
  getSession: () => Promise<{ user: { id: string; externalId: string } } | null>;
  findProjectScope: (
    projectId: string,
    userId: string,
  ) => Promise<{
    project: { id: string };
    organization: OrgLimitView & { id: string };
    role: string;
  } | null>;
  track?: (event: {
    externalId: string;
    projectId: string;
    organizationId: string;
    enabled: boolean;
  }) => Promise<void>;
}

export interface NightlySweepDeps {
  db?: ReturnType<typeof getDb>;
  flagDeps?: OrganizationFlagDeps;
  now?: () => Date;
}

/** What one project's nightly runs may spend on models in a UTC day. */
export const NIGHTLY_EVAL_BUDGET_USD = envNumber("EVAL_NIGHTLY_BUDGET_USD", 1, (n) => n >= 0);
export const NIGHTLY_ACTOR = "system:evals-nightly";
export const NIGHTLY_CAP_ERROR = "Stopped at the daily cap for nightly runs.";
export const NIGHTLY_PAID_ERROR = "Nightly runs need a paid plan.";
export const NIGHTLY_ADMIN_ERROR = "Only an admin can change nightly runs.";

const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const logger = getLogger("evals/nightly");

/** The drain sweep: queue one nightly run for each due project on a paid plan with Evals on. */
export async function enqueueDueNightlyEvalRuns(
  deps: NightlySweepDeps = {},
): Promise<{ enqueued: number }> {
  const db = deps.db ?? getDb();
  const now = deps.now?.() ?? new Date();
  // Owned: the plan is read per project through the entitlements port (no organizations table).
  const candidates = await db
    .select({ projectId: evalNightlySettings.projectId })
    .from(evalNightlySettings)
    .innerJoin(projects, eq(projects.id, evalNightlySettings.projectId))
    .where(eq(evalNightlySettings.enabled, true));
  let enqueued = 0;
  for (const { projectId } of candidates) {
    if (!(await organizationPaid(projectId, db))) continue;
    if (
      !(await evalsEnabledForActor(
        projectId,
        NIGHTLY_ACTOR,
        db,
        deps.flagDeps ?? defaultOrganizationFlagDeps,
      ))
    )
      continue;
    if (await queueIfDue(projectId, now, db)) enqueued++;
  }
  return { enqueued };
}

/** The server action's work: an admin of a paid organization with Evals on. Turning off needs only the admin. */
export async function setNightlyEvals(
  projectId: string,
  enabled: boolean,
  deps: SetNightlyDeps,
): Promise<ActionResult<NightlySetting>> {
  const session = await deps.getSession();
  if (!session) return { ok: false, error: "Sign in to change nightly runs." };
  const scope = UUID.test(projectId)
    ? await deps.findProjectScope(projectId, session.user.id)
    : null;
  if (!scope) return { ok: false, error: "No project you belong to has that ID." };
  if (!isAdmin(scope.role)) return { ok: false, error: NIGHTLY_ADMIN_ERROR };
  const actor = session.user.externalId;
  const db = deps.db ?? getDb();
  if (enabled) {
    if (!hasPaidPlan(scope.organization)) return { ok: false, error: NIGHTLY_PAID_ERROR };
    if (
      !(await evalsEnabledForActor(
        scope.project.id,
        actor,
        db,
        deps.flagDeps ?? defaultOrganizationFlagDeps,
      ))
    )
      return { ok: false, error: EVALS_OFF_ERROR };
  }
  const setAt = deps.now?.() ?? new Date();
  await db
    .insert(evalNightlySettings)
    .values({ projectId: scope.project.id, enabled, setBy: actor, setAt })
    .onConflictDoUpdate({
      target: evalNightlySettings.projectId,
      set: { enabled, setBy: actor, setAt },
    });
  logger.info({ project_id: scope.project.id, enabled, actor }, "eval_nightly_changed");
  await deps.track?.({
    externalId: actor,
    projectId: scope.project.id,
    organizationId: scope.organization.id,
    enabled,
  });
  return { ok: true, value: { enabled, setBy: actor, setAt } };
}

/** Due when no nightly run was queued yet on this UTC day. */
export function nightlyDue(lastQueuedAt: Date | null, now: Date): boolean {
  return lastQueuedAt === null || lastQueuedAt < utcDayStart(now);
}

/** What the Runs tab shows: the setting for an admin of a paid organization, else nothing. */
export function nightlyControlFor(
  role: string | null | undefined,
  organization: OrgLimitView,
  setting: NightlySetting | null,
): NightlySetting | null {
  if (!isAdmin(role) || !hasPaidPlan(organization)) return null;
  return setting ?? { enabled: false, setBy: null, setAt: null };
}

export async function loadNightlySetting(
  projectId: string,
  db: ReturnType<typeof getDb> = getDb(),
): Promise<NightlySetting | null> {
  const [row] = await db
    .select({
      enabled: evalNightlySettings.enabled,
      setBy: evalNightlySettings.setBy,
      setAt: evalNightlySettings.setAt,
    })
    .from(evalNightlySettings)
    .where(eq(evalNightlySettings.projectId, projectId))
    .limit(1);
  return row ?? null;
}

/** What is left of the project's nightly cap today, not counting `runId`. */
export async function nightlyBudgetLeft(
  projectId: string,
  runId: string,
  now: Date,
  db: Pick<ReturnType<typeof getDb>, "select">,
  capUsd: number = NIGHTLY_EVAL_BUDGET_USD,
): Promise<number> {
  const [row] = await db
    .select({
      usd: sql<string | number | null>`coalesce(sum((${evalRuns.spend}->>'usd')::numeric), 0)`,
    })
    .from(evalRuns)
    .where(
      and(
        eq(evalRuns.projectId, projectId),
        eq(evalRuns.kind, "nightly"),
        ne(evalRuns.id, runId),
        gte(evalRuns.createdAt, utcDayStart(now)),
      ),
    );
  return Math.max(0, capUsd - Number(row?.usd ?? 0));
}

export function utcDayStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
}

/** Lock the setting row, then queue only if it is still on and no nightly run exists today: two overlapping ticks queue one run. */
async function queueIfDue(
  projectId: string,
  now: Date,
  db: ReturnType<typeof getDb>,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [setting] = await tx
      .select({ enabled: evalNightlySettings.enabled })
      .from(evalNightlySettings)
      .where(eq(evalNightlySettings.projectId, projectId))
      .for("update");
    if (!setting?.enabled) return false;
    const [last] = await tx
      .select({ createdAt: evalRuns.createdAt })
      .from(evalRuns)
      .where(and(eq(evalRuns.projectId, projectId), eq(evalRuns.kind, "nightly")))
      .orderBy(desc(evalRuns.createdAt))
      .limit(1);
    if (!nightlyDue(last?.createdAt ?? null, now)) return false;
    const queued = await queueEvalRun(
      projectId,
      NIGHTLY_ACTOR,
      null,
      tx as unknown as ReturnType<typeof getDb>,
      "nightly",
      now,
    );
    if (!queued.ok) return false;
    logger.info(
      {
        project_id: projectId,
        run_id: queued.value.run.id,
        eval_count: queued.value.run.evalCount,
      },
      "eval_nightly_queued",
    );
    return queued.value.created;
  });
}
