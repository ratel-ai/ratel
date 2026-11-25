import {
  askEvalJudge,
  EVAL_JUDGE_FEATURE,
  type EvalJudge,
  type EvalJudgeEvidence,
  type EvalJudgePort,
  maxEvalJudgeTokens,
} from "@/lib/contracts/eval-judge";
import type { UsageLimitsPort, UsageSubject } from "@/lib/contracts/usage-limits";
import { getLogger } from "@/lib/platform/logger";
import type { recordModelCall } from "@/lib/platform/model-call";
import type { JudgeOutcome, JudgeRefusal } from "./domain/score";
import type { JudgeBudget } from "./ports/judge-budget";

export type JudgeDeps = {
  judge: EvalJudgePort;
  limits: Pick<UsageLimitsPort, "dailyBudgetUsd">;
  budget: JudgeBudget;
  recordModelCall: typeof recordModelCall;
  now: () => Date;
};

const logger = getLogger("evals/judge");

/** One yes or no question about one trial. It never throws: no answer is an outcome. */
export async function judgeTrial(
  subject: UsageSubject,
  evidence: EvalJudgeEvidence,
  deps: JudgeDeps,
): Promise<JudgeOutcome> {
  try {
    const judge = await deps.judge.judgeFor(subject);
    if (!judge) return none("not_configured", "No judge is configured.");
    return await ask(judge, subject, evidence, deps);
  } catch (error) {
    // The error's own text may quote the trial, so only its kind is logged.
    const kind = error instanceof Error ? error.constructor.name : typeof error;
    logger.error({ project_id: subject.projectId, reason: kind }, "eval judge call failed");
    return none("call_failed", "The call to the judge failed.");
  }
}

async function ask(
  judge: EvalJudge,
  subject: UsageSubject,
  evidence: EvalJudgeEvidence,
  deps: JudgeDeps,
): Promise<JudgeOutcome> {
  const maxUsd = maxEvalJudgeTokens(evidence) * judge.usdPerInputToken;
  const day = deps.now().toISOString().slice(0, 10);
  const { organizationId } = subject;
  const limit =
    judge.payer === "ratel" ? await deps.limits.dailyBudgetUsd(subject, "eval_judge") : null;
  if (limit !== null && !(await deps.budget.hold(organizationId, day, maxUsd, limit))) {
    deps.recordModelCall({
      provider: judge.provider,
      model: judge.model,
      feature: EVAL_JUDGE_FEATURE,
      payer: judge.payer,
      organizationId,
      projectId: subject.projectId,
      outcome: "refused_budget",
      durationMs: 0,
    });
    return none(
      "refused_budget",
      `The judge budget of this organization for today (${limit} USD) is used.`,
    );
  }
  // A failed call may be charged, so the hold stays until a call says what it used.
  const { answer, inputTokens } = await askEvalJudge(judge, evidence);
  if (limit !== null) {
    const spent = Math.min(maxUsd, inputTokens * judge.usdPerInputToken);
    await deps.budget.settle(organizationId, day, maxUsd, spent);
  }
  if (!answer) return none("no_answer", "The judge gave no answer.");
  return { status: "answered", model: judge.model, ...answer };
}

function none(code: JudgeRefusal, reason: string): JudgeOutcome {
  return { status: "not_scored", code, reason };
}
