import { getDb } from "@/lib/platform/db/client";
import { definitionSummary, hasVerdict } from "./format";
import {
  listTaskScorers,
  type ScorerDb,
  type ScorerSummary,
  scorerSummaries,
  scorerTrend,
} from "./store";
import type { ScorerKind } from "./types";

/** A scorer attached to a task, with its stored results of that task's traces. */
export interface TaskScorerScores {
  id: string;
  name: string;
  kind: ScorerKind;
  /** What it checks, in one line. */
  summary: string;
  /** Pass or fail; false: 1 to 5. */
  verdict: boolean;
  sampleRate: number;
  /** Every task it is attached to, this one included. */
  tasks: readonly string[];
  enabled: boolean;
  /** The last 7 days; null without a result. */
  week: ScorerSummary | null;
  /** Fourteen UTC days, oldest first. */
  trend: { day: string; scored: number; value: number | null }[];
}

const DAY_MS = 86_400_000;
const TREND_DAYS = 14;

/** A task's live scoring: the scorers attached to it, oldest first, from `trace_scores`. */
export async function loadTaskScorers(
  projectId: string,
  taskId: string,
  now: Date,
  db: ScorerDb = getDb(),
): Promise<TaskScorerScores[]> {
  const scorers = await listTaskScorers(projectId, taskId, db);
  if (scorers.length === 0) return [];
  const days = Array.from({ length: TREND_DAYS }, (_, index) =>
    new Date(now.getTime() - (TREND_DAYS - 1 - index) * DAY_MS).toISOString().slice(0, 10),
  );
  const [summaries, trends] = await Promise.all([
    scorerSummaries(projectId, new Date(now.getTime() - 7 * DAY_MS), db, taskId),
    Promise.all(
      scorers.map(({ id }) =>
        scorerTrend(projectId, id, new Date(`${days[0]}T00:00:00Z`), db, taskId),
      ),
    ),
  ]);
  return scorers.map((scorer, index) => {
    const verdict = hasVerdict(scorer);
    const byDay = new Map(trends[index]?.map((row) => [row.day, row]));
    return {
      id: scorer.id,
      name: scorer.name,
      kind: scorer.kind,
      summary: definitionSummary(scorer),
      verdict,
      sampleRate: scorer.sampleRate,
      tasks: scorer.tasks ?? [],
      enabled: scorer.enabled,
      week: summaries.get(scorer.id) ?? null,
      trend: days.map((day) => {
        const row = byDay.get(day);
        return {
          day,
          scored: row?.scored ?? 0,
          value: row ? (verdict ? row.passRate : row.average) : null,
        };
      }),
    };
  });
}
