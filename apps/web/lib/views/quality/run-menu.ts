import type { MatchQualityRunRow } from "@/lib/synthesis/match-quality/schema";
import { formatGap, nextScheduledRun, runStatus } from "@/lib/synthesis/match-quality/view";
import { plural } from "./model";

/**
 * The header's "Analyse searches" menu as plain data: the windows a run can
 * read, which of them have anything in them, the plan's allowance and where
 * the last run stands. Computed on the server, so the client menu only renders
 * and calls the existing run action.
 */

export type RunBudget =
  | { spent: false; remaining: number }
  | { spent: true; limit: number; resetsAt: Date };

export interface RunWindowOption {
  days: number;
  label: string;
  /** "312 searches", "No searches". */
  detail: string;
  disabled: boolean;
}

export interface RunMenuModel {
  /** A run is queued or reading: the trigger spins and the page polls. */
  live: boolean;
  label: string;
  /** One line on the last run. */
  status: string;
  windows: RunWindowOption[];
  /** The allowance, in words. */
  budget: string;
  nextRun: string | null;
}

export function runMenuModel({
  run,
  windows,
  counts,
  budget,
  now,
}: {
  run: MatchQualityRunRow | null;
  windows: readonly number[];
  counts: ReadonlyMap<number, number>;
  budget: RunBudget;
  now: Date;
}): RunMenuModel {
  const live = run !== null && runStatus(run).live;
  const due = nextScheduledRun(run, now);
  return {
    live,
    label: live ? "Analysing…" : "Analyse searches",
    status: runStatusLine(run, now),
    windows: windows.map((days) => {
      const count = counts.get(days);
      return {
        days,
        label: `Last ${days} days`,
        detail:
          count === undefined
            ? ""
            : count === 0
              ? "No searches"
              : plural(count, "search", "searches"),
        disabled: live || budget.spent || count === 0,
      };
    }),
    budget: budgetLine(budget),
    nextRun: due && !live ? `Next automatic run in ${formatGap(now, due)}` : null,
  };
}

export function runStatusLine(
  run: Pick<MatchQualityRunRow, "status" | "createdAt" | "finishedAt"> | null,
  now: Date,
): string {
  if (run === null) return "Not analysed yet";
  const status = runStatus(run);
  if (status.phase === "queued") return "Queued";
  if (status.phase === "running") return "Reading your searches";
  if (status.phase === "failed") return "The last analysis didn't finish";
  const at = run.finishedAt ?? run.createdAt;
  return now.getTime() - at.getTime() < 60_000
    ? "Analysed just now"
    : `Analysed ${formatGap(at, now)} ago`;
}

export function budgetLine(budget: RunBudget): string {
  if (budget.spent) {
    return `All ${budget.limit} runs used this month. More on ${dayMonth(budget.resetsAt)}.`;
  }
  if (!Number.isFinite(budget.remaining)) return "Unlimited runs";
  return `${plural(budget.remaining, "run")} left this month`;
}

/** "1 November". */
function dayMonth(at: Date): string {
  return at.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
}
