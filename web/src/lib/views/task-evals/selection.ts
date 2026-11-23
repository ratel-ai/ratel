import { and, desc, eq, inArray } from "drizzle-orm";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { traceTurnTopics } from "@/lib/readings/topics/schema";
import { traceSignals } from "@/lib/readings/trace-signals/schema";
import { type EvalDb, loadRuns, selectRuns } from "@/lib/views/eval-gate/runs";
import { recordedView } from "@/lib/views/eval-gate/simulate";
import { scoreRun } from "@/lib/views/task-scorers/engine";
import { scorersFor } from "@/lib/views/task-scorers/store";

export interface TaskEvalSelectionInput {
  projectId: string;
  taskId: string;
  targetRuns?: number;
  exclude?: ReadonlySet<string>;
}

export interface TaskEvalCandidate {
  turnId: string;
  origin: "auto" | "issue";
  selectionReason: string;
}

export interface TaskEvalSelection {
  candidates: TaskEvalCandidate[];
  /** Eligible evidence runs that do not receive an issue slot. */
  issueCapped: number;
}

const CANDIDATE_LIMIT = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Select scorer outcomes and intents from recent closed runs, plus open issue evidence. */
export async function selectTaskEvalRuns(
  input: TaskEvalSelectionInput,
  db: EvalDb = getDb(),
): Promise<TaskEvalCandidate[]> {
  return (await selectTaskEvalRunsWithStats(input, db)).candidates;
}

/** Select task cases and count eligible issue runs omitted by the evidence limits. */
export async function selectTaskEvalRunsWithStats(
  input: TaskEvalSelectionInput,
  db: EvalDb = getDb(),
): Promise<TaskEvalSelection> {
  const target = input.targetRuns ?? 20;
  if (!Number.isInteger(target) || target < 1 || target > CANDIDATE_LIMIT) {
    throw new Error("The target must be an integer from 1 to 200.");
  }
  const candidates = await selectRuns(
    {
      projectId: input.projectId,
      tasks: [input.taskId],
      tools: [],
      issueIds: [],
      limit: CANDIDATE_LIMIT,
      exclude: input.exclude,
    },
    db,
  );
  const runs = await loadRuns(
    input.projectId,
    candidates.map((row) => row.turnId),
    db,
  );
  const scorers = (await scorersFor(input.projectId, input.taskId, db)).filter(
    (row) => row.enabled,
  );
  const expectedTool = scorers.find((row) => row.kind === "expected_tool");
  const measured = candidates.flatMap((candidate) => {
    const run = runs.get(candidate.turnId);
    return run
      ? [
          {
            ...candidate,
            results: scoreRun(
              recordedView(run, expectedTool?.kind === "expected_tool" ? expectedTool.tool : null),
              scorers,
            ),
          },
        ]
      : [];
  });
  const topics =
    measured.length === 0
      ? []
      : await db
          .select({ turnId: traceTurnTopics.turnId, topicId: traceTurnTopics.topicId })
          .from(traceTurnTopics)
          .where(
            and(
              eq(traceTurnTopics.projectId, input.projectId),
              inArray(
                traceTurnTopics.turnId,
                measured.map((row) => row.turnId),
              ),
            ),
          );
  const intents = new Map(topics.map((row) => [row.turnId, row.topicId]));
  const picked = new Map<string, TaskEvalCandidate>();
  const add = (turnId: string, origin: TaskEvalCandidate["origin"], selectionReason: string) => {
    if (picked.size < target && !picked.has(turnId) && !input.exclude?.has(turnId))
      picked.set(turnId, { turnId, origin, selectionReason });
  };
  const issues = await db
    .select({ id: traceSignals.id, evidence: traceSignals.evidence })
    .from(traceSignals)
    .where(and(eq(traceSignals.projectId, input.projectId), eq(traceSignals.status, "open")))
    .orderBy(desc(traceSignals.severity), traceSignals.id);
  const evidenceByIssue = issues.map((issue) => ({
    id: issue.id,
    turnIds: Array.isArray(issue.evidence.turnIds)
      ? issue.evidence.turnIds.filter(
          (id): id is string => typeof id === "string" && UUID.test(id) && !input.exclude?.has(id),
        )
      : [],
  }));
  const evidenceIds = [...new Set(evidenceByIssue.flatMap((issue) => issue.turnIds))];
  const eligible = new Set<string>();
  // Evidence can be older than the recent scoring pool. Only this task's closed runs qualify.
  for (let i = 0; i < evidenceIds.length; i += CANDIDATE_LIMIT) {
    const evidence = await db
      .select({ id: traceTurns.id })
      .from(traceTurns)
      .where(
        and(
          eq(traceTurns.projectId, input.projectId),
          eq(traceTurns.workflowId, input.taskId),
          eq(traceTurns.status, "closed"),
          inArray(traceTurns.id, evidenceIds.slice(i, i + CANDIDATE_LIMIT)),
        ),
      )
      .orderBy(desc(traceTurns.endedAt), desc(traceTurns.id));
    for (const row of evidence) eligible.add(row.id);
  }
  const issueCases = new Map<string, TaskEvalCandidate>();
  const issueLimit = Math.ceil(target / 3);
  for (const issue of evidenceByIssue) {
    let count = 0;
    for (const turnId of eligible) {
      if (issueCases.size >= issueLimit || count >= 2) break;
      if (!issue.turnIds.includes(turnId) || issueCases.has(turnId)) continue;
      issueCases.set(turnId, {
        turnId,
        origin: "issue",
        selectionReason: `Evidence of issue ${issue.id}.`,
      });
      count++;
    }
  }
  const issueCapped = eligible.size - issueCases.size;
  const automaticBudget = target - issueCases.size;
  const share = Math.ceil(target / Math.max(1, scorers.length * 2));
  const buckets = scorers.flatMap((scorer) =>
    (["pass", "fail"] as const).map((status) =>
      spreadByIntent(
        measured.filter(
          (row) =>
            !issueCases.has(row.turnId) &&
            row.results.some((result) => result.kind === scorer.kind && result.status === status),
        ),
        intents,
      ),
    ),
  );
  // Give each scorer outcome one sample before increasing any outcome's share.
  for (let round = 1; round <= share; round++) {
    for (const bucket of buckets) {
      if (picked.size >= automaticBudget) break;
      if (bucket.filter((row) => picked.has(row.turnId)).length >= round) continue;
      const row = bucket.find((row) => !picked.has(row.turnId));
      if (row) add(row.turnId, "auto", reasonFor(row.results));
    }
  }
  for (const row of issueCases.values()) add(row.turnId, row.origin, row.selectionReason);
  for (const row of spreadByIntent(measured, intents)) {
    if (picked.size >= target) break;
    add(row.turnId, "auto", reasonFor(row.results));
  }
  return { candidates: [...picked.values()], issueCapped };
}

function reasonFor(results: ReturnType<typeof scoreRun>): string {
  return (
    results.map((result) => `${result.kind}: ${result.status}`).join(", ") || "No enabled scorers."
  );
}

function spreadByIntent<T extends { turnId: string }>(
  runs: readonly T[],
  intents: ReadonlyMap<string, string | null>,
): T[] {
  const groups = new Map<string | null, T[]>();
  for (const run of runs) {
    const key = intents.get(run.turnId) ?? null;
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }
  const result: T[] = [];
  for (let i = 0; result.length < runs.length; i++) {
    for (const group of groups.values()) if (group[i]) result.push(group[i]!);
  }
  return result;
}
