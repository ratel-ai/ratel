import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { jobs } from "@/lib/jobs/schema";
import { getDb } from "@/lib/platform/db/client";
import type { CraftBacktest } from "@/lib/synthesis/tool-crafter/backtest";
import { craftKey } from "@/lib/synthesis/tool-crafter/craft-key";
import {
  type NewToolCraftProposalRow,
  type ToolCraftProposalRow,
  type ToolCraftRunRow,
  toolCraftProposals,
  toolCraftRuns,
} from "@/lib/synthesis/tool-crafter/schema";
import type {
  CraftEvidence,
  CraftedProposalBody,
  CraftStatus,
  SourceTool,
} from "@/lib/synthesis/tool-crafter/types";

/**
 * The database side of the Tool Crafter: the run lifecycle, proposals and their
 * review transitions, the coalesced job enqueue. Every function takes an
 * injectable `db`.
 */

export type CrafterDb = ReturnType<typeof getDb>;
export const CRAFT_JOB_KIND = "craft_tools";
const LIVE_STATUSES = ["queued", "running"] as const;

// --- jobs ---------------------------------------------------------------------

/** One queued `craft_tools` per project (partial unique index); null when one is waiting. */
/** Who asked for a crafting run: the explorer run it follows, or a person or MCP client. */
export type CraftTrigger = "chained" | "manual";

export async function enqueueCraftJob(
  projectId: string,
  db: Pick<CrafterDb, "insert"> = getDb(),
  trigger: CraftTrigger = "manual",
): Promise<{ id: string } | null> {
  const rows = await db
    .insert(jobs)
    .values({ projectId, kind: CRAFT_JOB_KIND, status: "queued", payload: { trigger } })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return rows[0] ?? null;
}

// --- runs ---------------------------------------------------------------------

export async function startCraftRun(
  input: { projectId: string; trigger: string; explorerRunId: string | null },
  db: Pick<CrafterDb, "insert"> = getDb(),
  now: Date = new Date(),
): Promise<ToolCraftRunRow | null> {
  const [row] = await db
    .insert(toolCraftRuns)
    .values({ ...input, status: "running", startedAt: now, createdAt: now })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

export async function reapStaleCraftRuns(
  projectId: string,
  before: Date,
  db: Pick<CrafterDb, "update"> = getDb(),
  now: Date = new Date(),
): Promise<number> {
  const reaped = await db
    .update(toolCraftRuns)
    .set({ status: "failed", error: "stale", finishedAt: now })
    .where(
      and(
        eq(toolCraftRuns.projectId, projectId),
        inArray(toolCraftRuns.status, [...LIVE_STATUSES]),
        lt(sql`coalesce(${toolCraftRuns.startedAt}, ${toolCraftRuns.createdAt})`, before),
      ),
    )
    .returning({ id: toolCraftRuns.id });
  return reaped.length;
}

export async function failCraftRun(
  runId: string,
  error: string,
  db: Pick<CrafterDb, "update"> = getDb(),
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(toolCraftRuns)
    .set({ status: "failed", error: error.slice(0, 2_000), finishedAt: now })
    .where(eq(toolCraftRuns.id, runId));
}

export async function latestCraftRun(
  projectId: string,
  db: Pick<CrafterDb, "select"> = getDb(),
): Promise<ToolCraftRunRow | null> {
  const [row] = await db
    .select()
    .from(toolCraftRuns)
    .where(eq(toolCraftRuns.projectId, projectId))
    .orderBy(desc(toolCraftRuns.createdAt))
    .limit(1);
  return row ?? null;
}

// --- proposals ----------------------------------------------------------------

export interface NewProposal {
  body: CraftedProposalBody;
  sources: SourceTool[];
  evidence: CraftEvidence;
  backtest?: CraftBacktest | null;
}

export interface FinishCraftRunInput {
  runId: string;
  projectId: string;
  /** The explorer run the proposals were read from; null when there was none to read. */
  explorerRunId: string | null;
  proposals: readonly NewProposal[];
  candidates: Record<string, unknown>[];
  declinedReason: string | null;
  now: Date;
}

function proposalRow(input: FinishCraftRunInput, proposal: NewProposal): NewToolCraftProposalRow {
  const { body } = proposal;
  return {
    runId: input.runId,
    projectId: input.projectId,
    kind: body.kind,
    status: "pending",
    sourceToolIds: body.sourceToolIds,
    sourceDefinitions: proposal.sources as unknown as Record<string, unknown>[],
    crafted: body.crafted as unknown as Record<string, unknown>[],
    hiddenToolIds: body.hidden,
    rationale: body.rationale,
    details: body.details,
    expectedEffect: body.expectedEffect,
    migrationNotes: body.migrationNotes,
    evidence: proposal.evidence as unknown as Record<string, unknown>,
    backtest: (proposal.backtest ?? null) as unknown as Record<string, unknown> | null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export { craftKey };

/** The new drafts minus the changes a person already dismissed. */
export function withoutDismissed<
  T extends { body: { kind: string; sourceToolIds: readonly string[] } },
>(proposals: readonly T[], dismissed: ReadonlySet<string>): T[] {
  return proposals.filter(
    (proposal) => !dismissed.has(craftKey(proposal.body.kind, proposal.body.sourceToolIds)),
  );
}

/**
 * Finish a run in one transaction: the project's still-pending proposals from
 * earlier runs become `superseded`, the new ones are inserted (minus the
 * changes a person dismissed on Fixes), and the run is marked crafted with its
 * counts. Says how many drafts it kept and how many were already dismissed.
 */
export async function finishCraftRun(
  input: FinishCraftRunInput,
  db: Pick<CrafterDb, "transaction"> = getDb(),
): Promise<{ created: number; dismissed: number }> {
  return db.transaction(async (tx) => {
    await tx
      .update(toolCraftProposals)
      .set({ status: "superseded", updatedAt: input.now })
      .where(
        and(
          eq(toolCraftProposals.projectId, input.projectId),
          eq(toolCraftProposals.status, "pending"),
        ),
      );
    const dismissedRows = await tx
      .select({ kind: toolCraftProposals.kind, sourceToolIds: toolCraftProposals.sourceToolIds })
      .from(toolCraftProposals)
      .where(
        and(
          eq(toolCraftProposals.projectId, input.projectId),
          eq(toolCraftProposals.status, "dismissed"),
        ),
      );
    const proposals = withoutDismissed(
      input.proposals,
      new Set(dismissedRows.map((row) => craftKey(row.kind, row.sourceToolIds))),
    );
    if (proposals.length > 0) {
      await tx.insert(toolCraftProposals).values(proposals.map((p) => proposalRow(input, p)));
    }
    await tx
      .update(toolCraftRuns)
      .set({
        status: "crafted",
        explorerRunId: input.explorerRunId,
        candidates: input.candidates,
        proposalsCreated: proposals.length,
        declinedReason: input.declinedReason,
        finishedAt: input.now,
      })
      .where(eq(toolCraftRuns.id, input.runId));
    return { created: proposals.length, dismissed: input.proposals.length - proposals.length };
  });
}

export async function listCraftProposals(
  projectId: string,
  filter: { statuses?: readonly CraftStatus[]; limit?: number } = {},
  db: Pick<CrafterDb, "select"> = getDb(),
): Promise<ToolCraftProposalRow[]> {
  return db
    .select()
    .from(toolCraftProposals)
    .where(
      and(
        eq(toolCraftProposals.projectId, projectId),
        filter.statuses ? inArray(toolCraftProposals.status, [...filter.statuses]) : undefined,
      ),
    )
    .orderBy(desc(toolCraftProposals.createdAt))
    .limit(Math.min(500, Math.max(1, filter.limit ?? 100)));
}

/**
 * A person dismissed a drafted change on Fixes. Only a pending draft can be
 * dismissed; the answer says whether one was. Every other pending draft of
 * the same change (its kind and the same tools, `craftKey`) goes with it, in
 * the same statement: Fixes shows such drafts as one fix, so one dismissal
 * must not leave the other to reappear.
 */
export async function dismissCraftProposal(
  projectId: string,
  id: string,
  now: Date,
  db: Pick<CrafterDb, "execute"> = getDb(),
): Promise<boolean> {
  const result = await db.execute(sql`
    with target as (
      select kind, source_tool_ids from ${toolCraftProposals}
      where project_id = ${projectId} and id = ${id} and status = 'pending'
    )
    update ${toolCraftProposals} as draft
    set status = 'dismissed', updated_at = ${now.toISOString()}::timestamptz
    from target
    where draft.project_id = ${projectId} and draft.status = 'pending' and draft.kind = target.kind
      and draft.source_tool_ids @> target.source_tool_ids and draft.source_tool_ids <@ target.source_tool_ids
    returning draft.id
  `);
  return (result.rows as { id?: unknown }[]).some((row) => row.id === id);
}

export async function getCraftProposal(
  projectId: string,
  id: string,
  db: Pick<CrafterDb, "select"> = getDb(),
): Promise<ToolCraftProposalRow | null> {
  const [row] = await db
    .select()
    .from(toolCraftProposals)
    .where(and(eq(toolCraftProposals.projectId, projectId), eq(toolCraftProposals.id, id)))
    .limit(1);
  return row ?? null;
}
