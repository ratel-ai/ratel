import { composition } from "@/lib/composition/ports";
import { getDb } from "@/lib/platform/db/client";
import { recordModelCall } from "@/lib/platform/model-call";
import { usageLimits } from "@/lib/platform/usage-limits";
import { createDecisionJudge } from "./adapters/decision-judge";
import { createDrizzleJudgeBudget } from "./adapters/drizzle-judge-budget";
import type { JudgeDeps } from "./judge";

const decisionJudge = createDecisionJudge();

/** The edition's judge of evals, else the core's decision engine. */
export function judgeDeps(): JudgeDeps {
  return {
    judge: composition.evalJudge ?? decisionJudge,
    limits: usageLimits(),
    budget: createDrizzleJudgeBudget(getDb()),
    recordModelCall,
    now: () => new Date(),
  };
}
