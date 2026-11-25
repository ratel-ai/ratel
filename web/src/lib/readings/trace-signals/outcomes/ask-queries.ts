import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import {
  type StoredVerdict,
  UNKNOWN_ANSWER,
  type VerdictKey,
} from "@/lib/readings/trace-signals/outcomes/ask";
import { traceWorkflowVerdicts } from "@/lib/readings/trace-signals/schema";

/**
 * The answer cache of the outcome questions (`ask.ts`), in
 * `trace_workflow_verdicts`: the table every closed decision of Agent health
 * is cached in, keyed by (project, content hash, question hash).
 *
 * A row's `prompt_hash` is the content's hash and its `options_hash` the
 * question's, prefixed so it can never meet another surface's option set. An
 * answer is `verdict = 'workflow'` with the answer in `workflow_id`; an
 * abstention is `verdict = 'unclear'` and reads back as `unknown`.
 *
 * PRIVACY: hashes, a closed answer and a probability. Never the content.
 */

export type VerdictDb = Pick<ReturnType<typeof getDb>, "select" | "insert">;

const OPTIONS_PREFIX = "outcome:";
const CHUNK = 500;

/** The cached answers of these (content, question) pairs; a pair never asked is absent. */
export async function loadOutcomeVerdicts(
  projectId: string,
  keys: readonly VerdictKey[],
  db: VerdictDb = getDb(),
): Promise<StoredVerdict[]> {
  const byQuestion = new Map<string, Set<string>>();
  for (const key of keys)
    byQuestion.set(
      key.questionHash,
      (byQuestion.get(key.questionHash) ?? new Set()).add(key.contentHash),
    );
  const out: StoredVerdict[] = [];
  for (const [questionHash, contents] of byQuestion) {
    const hashes = [...contents];
    for (let i = 0; i < hashes.length; i += CHUNK) {
      const rows = await db
        .select({
          contentHash: traceWorkflowVerdicts.promptHash,
          verdict: traceWorkflowVerdicts.verdict,
          answer: traceWorkflowVerdicts.workflowId,
          probability: traceWorkflowVerdicts.confidence,
        })
        .from(traceWorkflowVerdicts)
        .where(
          and(
            eq(traceWorkflowVerdicts.projectId, projectId),
            eq(traceWorkflowVerdicts.optionsHash, `${OPTIONS_PREFIX}${questionHash}`),
            inArray(traceWorkflowVerdicts.promptHash, hashes.slice(i, i + CHUNK)),
          ),
        );
      for (const row of rows) {
        const answer = row.verdict === "workflow" && row.answer ? row.answer : UNKNOWN_ANSWER;
        out.push({
          contentHash: row.contentHash,
          questionHash,
          answer,
          probability: row.probability,
        });
      }
    }
  }
  return out;
}

/** Keep these answers. One already kept stays as it is. */
export async function saveOutcomeVerdicts(
  projectId: string,
  model: string,
  rows: readonly StoredVerdict[],
  db: VerdictDb = getDb(),
): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db
      .insert(traceWorkflowVerdicts)
      .values(
        rows.slice(i, i + CHUNK).map((row) => ({
          projectId,
          promptHash: row.contentHash,
          optionsHash: `${OPTIONS_PREFIX}${row.questionHash}`,
          verdict: row.answer === UNKNOWN_ANSWER ? "unclear" : "workflow",
          workflowId: row.answer === UNKNOWN_ANSWER ? null : row.answer,
          confidence: row.probability,
          model,
        })),
      )
      .onConflictDoNothing();
  }
}
