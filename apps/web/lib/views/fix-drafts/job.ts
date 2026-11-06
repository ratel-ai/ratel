import { eq } from "drizzle-orm";
import { costFor } from "@/lib/ingest/pricing";
import { loadToolCorpus } from "@/lib/ingest/runtime-catalog/inventory";
import { createBackgroundObservability } from "@/lib/jobs/observability";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { parseAnalystResponse } from "@/lib/synthesis/match-quality/analyst";
import { type AnalystContext, buildAnalystPrompt } from "@/lib/synthesis/match-quality/context";
import { changeOf, emptyChange, hasEffect } from "@/lib/views/eval-gate/change";
import { evalGateEnabledForActor } from "@/lib/views/eval-gate/gate";
import { DAILY_ORG_BUDGET_USD } from "@/lib/views/eval-gate/models";
import { loadEvidenceTurnIds, loadRuns } from "@/lib/views/eval-gate/runs";
import type { loadFixContext } from "@/lib/views/eval-gate/service";
import { searchFor } from "@/lib/views/eval-gate/simulate";
import {
  DRAFT_BUDGET_USD,
  DRAFT_MAX_TOKENS,
  type DraftModel,
  draftModelAvailable,
  draftModelFromEnv,
  recordNoDraftKey,
} from "@/lib/views/fix-drafts/model";
import { DRAFT_FIX_ACTOR, enqueueDraftFix } from "@/lib/views/fix-drafts/resolve";
import { fixDrafts } from "@/lib/views/fix-drafts/schema";
import { latestFixDraft, reserveFixDraft } from "@/lib/views/fix-drafts/store";

type Env = Record<string, string | undefined>;

/** Owned (ADR-0030): `env` (the gate and the model key) where upstream takes flag deps. */
export interface DraftFixDeps {
  db?: ReturnType<typeof getDb>;
  env?: Env;
  environment?: string;
  now?: () => Date;
  loadFix?: typeof loadFixContext;
  model?: DraftModel;
  dailyBudgetUsd?: number;
}

const logger = getLogger("fix-drafts/job");

/** Draft one fix. A disabled gate makes no model call. */
export async function draftFixJob(projectId: string, payload: unknown, deps: DraftFixDeps = {}) {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("fixId" in payload) ||
    typeof payload.fixId !== "string" ||
    !payload.fixId.trim()
  )
    return { status: "invalid_payload" };
  const db = deps.db ?? getDb();
  const env = deps.env ?? process.env;
  const actor =
    "requestedBy" in payload && typeof payload.requestedBy === "string"
      ? payload.requestedBy
      : DRAFT_FIX_ACTOR;
  if (!(await evalGateEnabledForActor(projectId, actor, db, env))) return { status: "gate_off" };
  const loadFix = deps.loadFix ?? (await import("@/lib/views/eval-gate/service")).loadFixContext;
  const ctx = await loadFix(projectId, payload.fixId);
  if (!ctx) return { status: "fix_not_found" };
  const fix = ctx.fix;
  if ((fix.kind !== "rewrite" && fix.kind !== "tell-apart") || hasEffect(changeOf(fix)))
    return { status: "not_needed" };
  const existing = await latestFixDraft(projectId, fix.id, db);
  if (existing?.status === "ready") return { status: "ready", id: existing.id };
  const ids = new Set(fix.subject.tools.map((tool) => tool.id));
  const corpus = (await loadToolCorpus(projectId, db)).filter((tool) => ids.has(tool.entryId));
  if (!corpus.length) return { status: "tool_not_found" };
  // Owned (ADR-0030): with no key there is no model, so nothing is reserved, written or sent.
  const model = deps.model ?? draftModelFromEnv(env, deps.environment, corpus);
  if (!model) {
    recordNoDraftKey(env);
    return { status: "no_model" };
  }
  const turnIds = await loadEvidenceTurnIds(
    projectId,
    fix.issues.map((issue) => issue.id),
    db,
  );
  const runs = await loadRuns(projectId, turnIds.slice(0, 20), db);
  const context: AnalystContext = {
    projectName: projectId,
    corpus,
    candidates: corpus.map((tool) => {
      const failures = [...runs.values()].flatMap((run) => {
        if (!run.steps.some((step) => step.kind === "invoke" && step.targetId === tool.entryId))
          return [];
        const search = searchFor(run, tool.entryId);
        if (!search?.query) return [];
        const rank = search.hitIds?.indexOf(tool.entryId) ?? -1;
        return [
          {
            query: search.query,
            ourRank: rank >= 0 ? rank + 1 : null,
            ourTop: search.hitIds?.[0] ?? null,
            baselineTop: null,
            targetSource: "invoked" as const,
          },
        ];
      });
      const misses = failures.filter((failure) => failure.ourRank === null).length;
      const buried = failures.filter(
        (failure) => failure.ourRank !== null && failure.ourRank > 1,
      ).length;
      return {
        entryId: tool.entryId,
        name: tool.name,
        misses,
        buried,
        targeted: failures.length,
        distractions: 0,
        loss: misses,
        failures,
      };
    }),
    census: {
      selectionsEvaluated: runs.size,
      revealedN: runs.size,
      referenceN: 0,
      judgedN: 0,
      queriesCaptured: runs.size,
      truncated: false,
      attributionMode: "tool-id",
      invokedToolKey: null,
      revealedSource: "trace-events",
      baselineArm: null,
      servingArm: null,
      tunedArm: null,
    },
    retrieval: { stages: [], topK: null, samples: runs.size },
    quality: [],
    gapNote: fix.why,
  };
  const prompt = buildAnalystPrompt(context);
  const now = (deps.now ?? (() => new Date()))();
  // UTF-8 bytes bound input tokens. The allowance covers message framing.
  const inputBound = Buffer.byteLength(prompt.system + prompt.user, "utf8") + 1024;
  const worstCost = costFor(model.model, {
    input_tokens: inputBound,
    output_tokens: DRAFT_MAX_TOKENS,
  });
  const pricedSonnet =
    /^claude-sonnet-/.test(model.model) && worstCost !== null && worstCost <= DRAFT_BUDGET_USD;
  const { row, created } = await reserveFixDraft(
    {
      projectId,
      fixId: fix.id,
      model: model.model,
      capUsd: pricedSonnet ? DRAFT_BUDGET_USD : 0,
      dailyBudgetUsd: deps.dailyBudgetUsd ?? DAILY_ORG_BUDGET_USD,
      now,
      actor,
    },
    db,
  );
  if (row.status !== "drafting") {
    await finished(row.status, 0);
    return { status: row.status, id: row.id };
  }
  // A concurrent handler must not use another handler's reservation.
  if (!created) return { status: "drafting", id: row.id };
  const startedAt = Date.now();
  let actualSpend:
    | { usd: number; calls: number; models: string[]; inputTokens: number; outputTokens: number }
    | undefined;
  try {
    const reply = await model.complete({ ...prompt, maxTokens: DRAFT_MAX_TOKENS });
    actualSpend = {
      usd:
        costFor(model.model, {
          input_tokens: reply.usage.inputTokens,
          output_tokens: reply.usage.outputTokens,
        }) ?? DRAFT_BUDGET_USD,
      calls: 1,
      models: [model.model],
      inputTokens: reply.usage.inputTokens,
      outputTokens: reply.usage.outputTokens,
    };
    const parsed = parseAnalystResponse(
      reply.text,
      ids,
      new Map(corpus.map((tool) => [tool.entryId, tool.searchable])),
    );
    if (!parsed.proposals.length) {
      // The model's judgement, not a fault: it kept the current text or named another tool.
      logger.warn(
        {
          project_id: projectId,
          fix_id: fix.id,
          rejected: parsed.rejectedEntryIds,
          diagnosis: parsed.diagnosis,
        },
        "fix draft had no usable proposal",
      );
      await db
        .update(fixDrafts)
        .set({ status: "failed", spend: actualSpend })
        .where(eq(fixDrafts.id, row.id));
      await finished("failed", actualSpend.usd, Date.now() - startedAt);
      return {
        status: "failed",
        id: row.id,
        reason: "no_usable_draft",
        rejected: parsed.rejectedEntryIds,
      };
    }
    const change = emptyChange();
    for (const proposal of parsed.proposals)
      change.patches[proposal.entryId] = proposal.searchableDescription;
    await db
      .update(fixDrafts)
      .set({ change, spend: actualSpend, status: "ready" })
      .where(eq(fixDrafts.id, row.id));
    await finished("ready", actualSpend.usd, Date.now() - startedAt);
    return { status: "ready", id: row.id };
  } catch (err) {
    // The job runner reports the rethrown error, so it is not reported here too.
    logger.error({ err, project_id: projectId, fix_id: fix.id }, "fix draft failed");
    // Retain the reservation when the provider may have charged a failed call.
    await db
      .update(fixDrafts)
      .set({ status: "failed", ...(actualSpend ? { spend: actualSpend } : {}) })
      .where(eq(fixDrafts.id, row.id));
    await finished("failed", actualSpend?.usd ?? DRAFT_BUDGET_USD, Date.now() - startedAt);
    throw err;
  }

  async function finished(status: string, costUsd: number, durationMs = 0) {
    const fields = {
      project_id: projectId,
      fix_id: fix.id,
      kind: fix.kind,
      status,
      model: model?.model ?? null,
      cost_usd: costUsd,
      duration_ms: durationMs,
    };
    logger.info(fields, "fix_draft_finished");
    await createBackgroundObservability().trackSystemEvent("fix_draft_finished", DRAFT_FIX_ACTOR, {
      object_action: "fix_draft_finished",
      ...fields,
    });
  }
}

/** Queue the new issue fixes after a signal run. No Quality analysis is required. */
export async function enqueueProjectFixDrafts(projectId: string, env: Env = process.env) {
  if (!(await evalGateEnabledForActor(projectId, DRAFT_FIX_ACTOR, undefined, env))) return;
  // Owned (ADR-0030): with no model there is nothing to draft, so nothing is queued.
  if (!draftModelAvailable(env)) return;
  const { getOrganizationByProjectId } = await import("@/lib/platform/organizations");
  const organization = await getOrganizationByProjectId(projectId);
  if (!organization) return;
  const { loadFixes } = await import("@/lib/views/fixes/load");
  const model = await loadFixes({ projectId, organization, topics: false });
  for (const fix of model.open) {
    if ((fix.kind !== "rewrite" && fix.kind !== "tell-apart") || hasEffect(changeOf(fix))) continue;
    const draft = await latestFixDraft(projectId, fix.id);
    if (draft?.status === "ready" || draft?.status === "drafting") continue;
    await enqueueDraftFix(projectId, fix.id);
  }
}
