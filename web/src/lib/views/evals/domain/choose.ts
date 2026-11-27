/**
 * "Let Ratel choose" for a dataset with no task: the turns that need attention first, then the
 * others, spread over the tasks so that one busy task does not take each row.
 *
 * 1. The failed turns and the turns with a low score (`LOW_SCORE`), the newest first, spread over
 *    their tasks: one turn of each task in turn.
 * 2. Then the other turns, the newest first, spread over their tasks in the same way.
 *
 * With a task, the selection of the task evals (`task-evals/selection.ts`) chooses instead: it
 * knows the scorers of the task, its intents and its open issues.
 */

/** A turn that Ratel can choose, with what it knows of its result. */
export type ChooseCandidate = {
  turnId: string;
  taskId: string | null;
  endedAt: Date;
  /** The turn ended with an error, or a scorer failed it. */
  failed: boolean;
  /** The mean of its scores from 0 to 1. Null with no score. */
  score: number | null;
};

/** A score under this is low. */
export const LOW_SCORE = 0.5;

export function chooseTurns(candidates: readonly ChooseCandidate[], limit: number): string[] {
  const newest = [...candidates].sort(
    (left, right) =>
      right.endedAt.getTime() - left.endedAt.getTime() || (left.turnId < right.turnId ? -1 : 1),
  );
  const needsAttention = ({ failed, score }: ChooseCandidate) =>
    failed || (score !== null && score < LOW_SCORE);
  const first = spread(newest.filter(needsAttention));
  const then = spread(newest.filter((candidate) => !needsAttention(candidate)));
  return [...new Set([...first, ...then].map(({ turnId }) => turnId))].slice(0, limit);
}

/** One of each task in turn, in the order of the tasks' newest turn. No task is a task too. */
function spread(candidates: readonly ChooseCandidate[]): ChooseCandidate[] {
  const byTask = Map.groupBy(candidates, ({ taskId }) => taskId ?? "");
  const groups = [...byTask.values()];
  const out: ChooseCandidate[] = [];
  for (let round = 0; out.length < candidates.length; round += 1) {
    for (const group of groups) {
      const candidate = group[round];
      if (candidate) out.push(candidate);
    }
  }
  return out;
}
