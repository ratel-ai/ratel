import { listTopSearchQueries } from "@/lib/ingest/trace-events/queries";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { listComparedQueries } from "@/lib/synthesis/traces/experiment-calibration-queries";

/**
 * Real prompts to test against, pulled from the project's own telemetry.
 *
 * Typing a prompt from memory tests the prompt you imagined; these are the ones
 * agents actually send. Two sources, because they answer different questions:
 *
 *  - **Flagged**: queries a calibration shadow run disagreed on. "The arms
 *    ranked this differently; what would my description have done?"
 *  - **Frequent**: the queries agents sent to capability search most often in
 *    the window. "This is asked constantly; is it well served?"
 *
 * A query can be both. Flagged wins the tie: a disagreement is a live lead, a
 * high count on its own is only context.
 */

export type PromptSource = "flagged" | "frequent";

export interface SuggestedPrompt {
  text: string;
  source: PromptSource;
  /** Times asked (frequent) or compared (flagged). */
  count: number;
  /** Comparisons where the arms disagreed. Null for a frequent-only prompt. */
  mismatches: number | null;
  /**
   * The disagreement this prompt is offered FOR, when there is one.
   *
   * Without it, picking a prompt from under "Arms disagreed on these" ran a
   * plain test and showed no arms, so the menu promised a comparison the page
   * then did not have. Carrying the selection lets the pick open exactly what
   * the Calibration mismatch browser opens.
   */
  selectionId: string | null;
  experimentName: string | null;
}

const logger = getLogger("playground/prompts");

/**
 * How many each group shows. The picker is a shortlist, not a browser: a busy
 * project can flag dozens of disagreements, and a menu that lists them all
 * buries the frequent asks under them and stops being scannable. Anything
 * deeper belongs on Calibration → mismatches, which is built for browsing.
 */
export const MAX_PER_SOURCE = 5;
/**
 * Read deeper than we show, so dedup has material: a query that is both flagged
 * and frequent collapses into one entry, and the frequent group should still be
 * able to fill its five from what is left.
 */
const SOURCE_FETCH_LIMIT = 15;

/** Both reads on one handle: a raw aggregate and a builder query. */
type PromptsDb = Pick<ReturnType<typeof getDb>, "select" | "execute">;

export interface SuggestedPromptsOptions {
  projectId: string;
  window: { since: Date; until: Date };
  db?: PromptsDb;
}

/**
 * One source failing must not cost the other one: a project with no calibration
 * data should still get its frequent asks. The failure is logged rather than
 * swallowed. An empty picker that silently means "the query is broken" is
 * indistinguishable from one that means "no telemetry yet", and that ambiguity
 * already hid a bad GROUP BY once.
 */
async function orEmpty<T>(
  source: string,
  projectId: string,
  load: () => Promise<T[]>,
): Promise<T[]> {
  try {
    return await load();
  } catch (err) {
    logger.error({ err, source, project_id: projectId }, "playground prompt source failed");
    return [];
  }
}

export async function loadSuggestedPrompts({
  projectId,
  window,
  db = getDb(),
}: SuggestedPromptsOptions): Promise<SuggestedPrompt[]> {
  const [flagged, frequent] = await Promise.all([
    orEmpty("calibration", projectId, () =>
      listComparedQueries(projectId, window, SOURCE_FETCH_LIMIT, db),
    ),
    orEmpty("searches", projectId, () =>
      listFrequentAsks(projectId, window.since, SOURCE_FETCH_LIMIT, db),
    ),
  ]);
  return mergePrompts(flagged, frequent);
}

/** The most searched queries since `since`, most-asked first. */
async function listFrequentAsks(
  projectId: string,
  since: Date,
  limit: number,
  db: PromptsDb,
): Promise<Array<{ text: string; occurrences: number }>> {
  const rows = await listTopSearchQueries(projectId, { since, limit }, db);
  return rows.map((row) => ({ text: row.query, occurrences: row.searches }));
}

/**
 * Merge the two sources, flagged first, deduped case-insensitively on the
 * trimmed text, and capped at {@link MAX_PER_SOURCE} PER GROUP rather than
 * overall. A shared cap let a project with many disagreements crowd the
 * frequent asks out of the list entirely; the two groups answer different
 * questions and each deserves its own room.
 *
 * Exported for its own tests, because the ordering rule is the whole point of the
 * picker and is easy to get subtly wrong.
 */
export function mergePrompts(
  flagged: ReadonlyArray<{
    query: string;
    comparisons: number;
    mismatches: number;
    mismatchSelectionId?: string | null;
    mismatchExperimentName?: string | null;
  }>,
  frequent: ReadonlyArray<{ text: string; occurrences: number }>,
): SuggestedPrompt[] {
  const seen = new Set<string>();
  const take = (
    candidates: Array<{ text: string; prompt: Omit<SuggestedPrompt, "text"> }>,
  ): SuggestedPrompt[] => {
    const group: SuggestedPrompt[] = [];
    for (const candidate of candidates) {
      if (group.length >= MAX_PER_SOURCE) break;
      const text = candidate.text.trim();
      const key = text.toLowerCase();
      if (text === "" || seen.has(key)) continue;
      seen.add(key);
      group.push({ text, ...candidate.prompt });
    }
    return group;
  };

  // Only queries that ACTUALLY disagreed. The group is labelled "Arms disagreed
  // on these", and a project with few mismatches used to have the remaining
  // slots filled from the rest of the compared queries, which put prompts the
  // arms agreed on under a heading saying they had not. A query with no
  // disagreement also has no selection to open, so it could not honour the
  // click either.
  const flaggedGroup = take(
    [...flagged]
      .filter((row) => row.mismatches > 0)
      .sort((a, b) => b.mismatches - a.mismatches || b.comparisons - a.comparisons)
      .map((row) => ({
        text: row.query,
        prompt: {
          source: "flagged" as const,
          count: row.comparisons,
          mismatches: row.mismatches,
          selectionId: row.mismatchSelectionId ?? null,
          experimentName: row.mismatchExperimentName ?? null,
        },
      })),
  );
  const frequentGroup = take(
    frequent.map((row) => ({
      text: row.text,
      prompt: {
        source: "frequent" as const,
        count: row.occurrences,
        mismatches: null,
        selectionId: null,
        experimentName: null,
      },
    })),
  );

  return [...flaggedGroup, ...frequentGroup];
}
