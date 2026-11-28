import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { projects } from "@/lib/platform/projects/schema";
import type { AskOutcome, AskTarget, EarlierAsk, RefusedWidget } from "./domain";
import { ASK_EARLIER_ASKS, ASK_LIMITS } from "./limits";
import { askRequests, type StoredDraft } from "./schema";

/**
 * The stored asks, and the limits of `ask-limits` they count. A draft first holds its place: under
 * the organization's lock it counts the asks of the day and of the minute and the spend of the
 * day, and inserts its row with its worst cost. The calls then settle the row with what they cost.
 * Every read names the project, or the organization of the project.
 */

export type AskDb = Pick<
  ReturnType<typeof getDb>,
  "select" | "insert" | "update" | "transaction" | "execute"
>;

/** Which limit stopped a draft. */
export type AskLimit = "org_daily_drafts" | "person_per_minute" | "org_daily_spend";

export type AskHold =
  | { ok: true; askId: string }
  | { ok: false; limit: AskLimit; resetsAt: Date; message: string };

export interface AskHoldInput {
  projectId: string;
  actor: string;
  surface: "console" | "mcp";
  target: AskTarget;
  dashboardId: string | null;
  words: string;
  model: string;
  /** The worst cost of the draft's calls, held until they settle. */
  reserveUsd: number;
  now: Date;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Holds the place of one draft, or says which limit stops it and when that limit resets. */
export async function holdAsk(input: AskHoldInput, db: AskDb = getDb()): Promise<AskHold> {
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select({ organizationId: projects.organizationId })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1);
    if (!project) throw new Error("The project of the ask does not exist.");
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`ask:${project.organizationId}`}, 0))`,
    );
    const dayStart = startOfUtcDay(input.now);
    const nextDay = new Date(dayStart.getTime() + DAY_MS);
    const [day] = await tx
      .select({
        drafts: sql<number>`count(*)::int`,
        usd: sql<number>`coalesce(sum(${askRequests.usd}), 0)::float8`,
      })
      .from(askRequests)
      .innerJoin(projects, eq(projects.id, askRequests.projectId))
      .where(
        and(
          eq(projects.organizationId, project.organizationId),
          gte(askRequests.createdAt, dayStart),
        ),
      );
    if ((day?.drafts ?? 0) >= ASK_LIMITS.draftsPerOrgPerDay)
      return stop(
        "org_daily_drafts",
        nextDay,
        `This organization asked for ${ASK_LIMITS.draftsPerOrgPerDay} drafts today, the most for one day.`,
      );
    if (Number(day?.usd ?? 0) + input.reserveUsd > ASK_LIMITS.usdPerOrgPerDay)
      return stop(
        "org_daily_spend",
        nextDay,
        `The drafts of this organization used their model budget of ${ASK_LIMITS.usdPerOrgPerDay} USD for today.`,
      );
    const minuteAgo = new Date(input.now.getTime() - MINUTE_MS);
    const [minute] = await tx
      .select({
        drafts: sql<number>`count(*)::int`,
        oldest: sql<string | null>`min(${askRequests.createdAt})`,
      })
      .from(askRequests)
      .innerJoin(projects, eq(projects.id, askRequests.projectId))
      .where(
        and(
          eq(projects.organizationId, project.organizationId),
          eq(askRequests.actor, input.actor),
          sql`${askRequests.createdAt} > ${minuteAgo.toISOString()}::timestamptz`,
        ),
      );
    if ((minute?.drafts ?? 0) >= ASK_LIMITS.draftsPerPersonPerMinute) {
      const oldest = minute?.oldest ? new Date(minute.oldest) : input.now;
      return stop(
        "person_per_minute",
        new Date(oldest.getTime() + MINUTE_MS),
        `You asked for ${ASK_LIMITS.draftsPerPersonPerMinute} drafts in one minute, the most for one minute.`,
      );
    }
    const [row] = await tx
      .insert(askRequests)
      .values({
        projectId: input.projectId,
        actor: input.actor,
        surface: input.surface,
        target: input.target,
        dashboardId: input.dashboardId,
        words: input.words,
        model: input.model,
        usd: input.reserveUsd,
        createdAt: input.now,
      })
      .returning({ id: askRequests.id });
    if (!row) throw new Error("The ask was not stored.");
    return { ok: true, askId: row.id };
  });
}

/** The calls of a draft ended: store what they cost, and the draft when there is one. */
export async function settleAsk(
  askId: string,
  usd: number,
  draft: StoredDraft | null,
  db: AskDb = getDb(),
): Promise<void> {
  await db
    .update(askRequests)
    .set({ usd, ...(draft ? { draft } : {}) })
    .where(eq(askRequests.id, askId));
}

/**
 * A dashboard ask made its dashboard (decision `ask-no-confirm`): the ask keeps the dashboard and
 * the ids of the widgets it made, and its outcome is kept until one of them changes.
 */
export async function linkAsk(
  projectId: string,
  askId: string,
  made: { dashboardId: string; widgetIds: readonly string[] },
  now: Date = new Date(),
  db: Pick<AskDb, "update"> = getDb(),
): Promise<void> {
  await db
    .update(askRequests)
    .set({
      dashboardId: made.dashboardId,
      widgetIds: [...made.widgetIds],
      outcome: "kept",
      outcomeAt: now,
    })
    .where(and(eq(askRequests.projectId, projectId), eq(askRequests.id, askId)));
}

/** A change to a dashboard, as the dashboard actions report it. */
export interface DashboardChange {
  projectId: string;
  dashboardId: string;
  action: string;
  /** The widget an edit or a removal changed. */
  widgetId?: string;
}

/**
 * The outcome of the asks that made a dashboard, after a change to it: edited when one of their
 * widgets is changed or removed, discarded when the dashboard is deleted. Other changes keep it.
 */
export async function followDashboardChange(
  change: DashboardChange,
  now: Date = new Date(),
  db: Pick<AskDb, "update"> = getDb(),
): Promise<void> {
  const made = and(
    eq(askRequests.projectId, change.projectId),
    eq(askRequests.dashboardId, change.dashboardId),
    eq(askRequests.target, "dashboard"),
    isNotNull(askRequests.widgetIds),
  );
  if (change.action === "delete") {
    await db.update(askRequests).set({ outcome: "discarded", outcomeAt: now }).where(made);
    return;
  }
  if ((change.action === "edit-widget" || change.action === "remove-widget") && change.widgetId)
    await db
      .update(askRequests)
      .set({ outcome: "edited", outcomeAt: now })
      .where(
        and(
          made,
          eq(askRequests.outcome, "kept"),
          sql`${askRequests.widgetIds} ? ${change.widgetId}`,
        ),
      );
}

/** The widgets a stored ask of the project left out, with their reason; null for no such ask. */
export async function askLeftOut(
  projectId: string,
  askId: string,
  db: Pick<AskDb, "select"> = getDb(),
): Promise<RefusedWidget[] | null> {
  const [row] = await db
    .select({ draft: askRequests.draft })
    .from(askRequests)
    .where(and(eq(askRequests.projectId, projectId), eq(askRequests.id, askId)))
    .limit(1);
  return row ? (row.draft?.refused ?? []) : null;
}

/**
 * Stores what the person did with a draft of the project. False when the project has no such ask,
 * or the ask has no draft.
 */
export async function setAskOutcome(
  projectId: string,
  askId: string,
  outcome: AskOutcome,
  now: Date = new Date(),
  db: AskDb = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(askRequests)
    .set({ outcome, outcomeAt: now })
    .where(
      and(
        eq(askRequests.projectId, projectId),
        eq(askRequests.id, askId),
        isNotNull(askRequests.draft),
      ),
    )
    .returning({ id: askRequests.id });
  return rows.length > 0;
}

/** The newest asks of the project that have a draft, with their outcome. */
export async function listEarlierAsks(
  projectId: string,
  limit: number = ASK_EARLIER_ASKS,
  db: Pick<AskDb, "select"> = getDb(),
): Promise<EarlierAsk[]> {
  const rows = await db
    .select({
      target: askRequests.target,
      words: askRequests.words,
      outcome: askRequests.outcome,
      draft: askRequests.draft,
    })
    .from(askRequests)
    .where(and(eq(askRequests.projectId, projectId), isNotNull(askRequests.draft)))
    .orderBy(desc(askRequests.createdAt), desc(askRequests.id))
    .limit(limit);
  return rows.map(({ target, words, outcome, draft }) => ({
    target,
    words,
    outcome,
    widgets: (draft?.widgets ?? []).map(({ title }) => title),
  }));
}

function stop(limit: AskLimit, resetsAt: Date, said: string): AskHold {
  return {
    ok: false,
    limit,
    resetsAt,
    message: `${said} Ask again after ${resetsAt.toISOString().slice(0, 16).replace("T", " ")} UTC.`,
  };
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
