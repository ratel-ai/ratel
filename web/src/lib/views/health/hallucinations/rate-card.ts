import { and, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import {
  GROUP_OF,
  HALLUCINATION_GROUPS,
  type HallucinationGroup,
  kindOf,
} from "@/lib/readings/trace-signals/hallucinations/kinds";
import { traceHallucinations } from "@/lib/readings/trace-signals/schema";
import type { WindowDays } from "@/lib/readings/trace-signals/view";
import { uncheckedReason } from "@/lib/views/health/hallucinations/page-model";
import {
  countWindowTurns,
  loadCoverage,
  loadLastRead,
  type PageDb,
} from "@/lib/views/health/hallucinations/page-queries";
import { hallucinationsHref } from "@/lib/views/health/hallucinations/paths";

/**
 * The hallucination rate on Agent health's Summary, beside Task completion:
 * the window's turns with at least one finding, of its closed turns, and the
 * way to the Hallucinations page. Null rate when the reading has not run or
 * the window holds no turn.
 */
export interface HallucinationRateCard {
  rate: number | null;
  turnsAffected: number;
  turns: number;
  occurrences: number;
  /** Whether the reading has run for the project. */
  read: boolean;
  /** Whether any group's rules had something to read in the window (`uncheckedReason`); false: nothing could be checked. */
  checked: boolean;
  /** Each group's occurrences, and whether it could be checked. */
  groups: Array<{ group: HallucinationGroup; occurrences: number; checked: boolean }>;
  href: string;
}

const DAY_MS = 86_400_000;

export async function loadHallucinationRateCard(
  projectId: string,
  windowDays: WindowDays,
  db: PageDb = getDb(),
  now: Date = new Date(),
): Promise<HallucinationRateCard> {
  const window = { from: new Date(now.getTime() - windowDays * DAY_MS), to: now };
  const [turns, lastRead, coverage, [found], byKind] = await Promise.all([
    countWindowTurns(projectId, window, db),
    loadLastRead(projectId, db),
    loadCoverage(projectId, window, db),
    db
      .select({
        occurrences: sql<number>`count(*)`.mapWith(Number),
        turnsAffected: sql<number>`count(distinct ${traceHallucinations.turnId})`.mapWith(Number),
      })
      .from(traceHallucinations)
      .where(
        and(
          eq(traceHallucinations.projectId, projectId),
          gte(traceHallucinations.occurredAt, window.from),
          lt(traceHallucinations.occurredAt, window.to),
        ),
      ),
    db
      .select({ kind: traceHallucinations.kind, n: sql<number>`count(*)`.mapWith(Number) })
      .from(traceHallucinations)
      .where(
        and(
          eq(traceHallucinations.projectId, projectId),
          gte(traceHallucinations.occurredAt, window.from),
          lt(traceHallucinations.occurredAt, window.to),
        ),
      )
      .groupBy(traceHallucinations.kind),
  ]);
  const perGroup = new Map<HallucinationGroup, number>();
  for (const row of byKind) {
    const kind = kindOf(row.kind);
    if (kind) perGroup.set(GROUP_OF[kind], (perGroup.get(GROUP_OF[kind]) ?? 0) + row.n);
  }
  const turnsAffected = found?.turnsAffected ?? 0;
  const read = lastRead.at !== null;
  // A group with a finding was checked, whatever the coverage reads.
  const checked =
    (found?.occurrences ?? 0) > 0 ||
    HALLUCINATION_GROUPS.some((group) => uncheckedReason(group, coverage) === null);
  return {
    rate: read && turns > 0 ? Math.min(1, turnsAffected / turns) : null,
    turnsAffected,
    turns,
    occurrences: found?.occurrences ?? 0,
    read,
    checked,
    groups: HALLUCINATION_GROUPS.map((group) => ({
      group,
      occurrences: perGroup.get(group) ?? 0,
      checked: (perGroup.get(group) ?? 0) > 0 || uncheckedReason(group, coverage) === null,
    })),
    href: hallucinationsHref(projectId, { days: windowDays }),
  };
}
