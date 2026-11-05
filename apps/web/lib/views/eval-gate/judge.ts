import { getLogger } from "@/lib/platform/logger";
import {
  type EvalGateFeature,
  estimateTokens,
  type JudgeModel,
  ModelRefused,
  recordBudgetRefusal,
  SMALL_MAX_TOKENS,
  type SpendMeter,
} from "./models";
import { endsWellOf } from "./outcome";
import type { JudgeStatus, RunView } from "./types";

/**
 * The model judge for the person's own words (RC-61): each run's expected
 * outcome and criteria, read against what each side of the simulation did.
 * Paired like every other check: both sides are judged by the same model on
 * the same description. Only pass or fail is kept, never the model's text.
 *
 * With no model configured nothing is called and the criteria read "not
 * judged": shown, never scored.
 */

const logger = getLogger("eval-gate/judge");

/** The judge's own instructions, for its estimate. */
const JUDGE_PROMPT_TOKENS = 400;

export const JUDGE_NOT_CONFIGURED = "Criteria not judged: no model configured";

/** A side in plain words, the only thing the judge reads. */
export function describeSide(view: RunView): string {
  const lines: string[] = [];
  if (view.listKnown !== false && view.firstList)
    lines.push(`Its first search listed: ${view.firstList.join(", ") || "nothing"}.`);
  if (view.calls) {
    const calls = view.calls.map(
      (name, index) => `${name} (${view.outcomes?.[index] === "error" ? "failed" : "ok"})`,
    );
    lines.push(
      calls.length > 0 ? `Tools it called, in order: ${calls.join(", ")}.` : "It called no tool.",
    );
    const ends = endsWellOf(view);
    if (view.outcomes && view.outcomes[view.outcomes.length - 1] === "error")
      lines.push("It ended on a failed call.");
    else if (view.answered === false)
      lines.push("It did not finish: it never gave a final answer.");
    else if (view.answered) lines.push("It finished with an answer to the user.");
    else if (ends === null) lines.push("How it ended isn't known.");
  } else {
    lines.push("Which tools it would call isn't known.");
  }
  return lines.join("\n");
}

export interface JudgeItem {
  caseId: string;
  /** The expected outcome and the criteria, in the person's words. */
  criteria: string;
  before: RunView;
  after: RunView;
}

export interface JudgeResult {
  readings: Map<string, { before: boolean | null; after: boolean | null }>;
  status: JudgeStatus;
}

/** Judge every run that has criteria, within the spend cap. */
export async function judgeCriteria(
  items: readonly JudgeItem[],
  judge: JudgeModel | null,
  spend: SpendMeter,
  feature: EvalGateFeature = "eval_gate_judge",
): Promise<JudgeResult> {
  const readings = new Map<string, { before: boolean | null; after: boolean | null }>();
  if (items.length === 0) return { readings, status: { status: "no-criteria" } };
  if (!judge) {
    for (const item of items) readings.set(item.caseId, { before: null, after: null });
    return { readings, status: { status: "not-configured" } };
  }
  let judged = 0;
  let skipped = 0;
  let refused = false;
  for (const item of items) {
    const sides = [describeSide(item.before), describeSide(item.after)] as const;
    // Room for both calls' worst case before either is made.
    const hold = refused
      ? null
      : await spend.reserve(judge.model, {
          inputTokens:
            2 * (JUDGE_PROMPT_TOKENS + estimateTokens(item.criteria, sides[0], sides[1])),
          outputTokens: 2 * SMALL_MAX_TOKENS,
        });
    if (!hold) {
      // Refused for want of room (not after a refused key): one line per case.
      if (!refused) recordBudgetRefusal(judge, feature);
      readings.set(item.caseId, { before: null, after: null });
      skipped += 1;
      continue;
    }
    try {
      const [before, after] = await Promise.all([
        judge.judge({ criteria: item.criteria, run: sides[0] }),
        judge.judge({ criteria: item.criteria, run: sides[1] }),
      ]);
      spend.charge(judge.model, before.usage);
      spend.charge(judge.model, after.usage);
      spend.release(hold);
      readings.set(item.caseId, { before: before.pass, after: after.pass });
      judged += 1;
    } catch (err) {
      spend.release(hold);
      // A refused key fails every call alike: stop asking.
      refused = err instanceof ModelRefused;
      logger.error({ err, case_id: item.caseId }, "fix eval criteria judge failed");
      readings.set(item.caseId, { before: null, after: null });
      skipped += 1;
    }
  }
  if (judge.standIn)
    return { readings, status: { status: "stand-in", model: judge.model, runs: judged } };
  if (skipped > 0)
    return { readings, status: { status: "budget", model: judge.model, runs: judged, skipped } };
  return { readings, status: { status: "judged", model: judge.model, runs: judged } };
}

/** The judge's status in words, for the eval page. */
export function judgeLine(status: JudgeStatus | null): string | null {
  if (!status) return null;
  switch (status.status) {
    case "not-configured":
      return JUDGE_NOT_CONFIGURED;
    case "no-criteria":
      return null;
    case "judged":
      return `Criteria judged by a model on ${status.runs} ${status.runs === 1 ? "run" : "runs"}`;
    case "stand-in":
      return `Criteria judged by a local stand-in, not a model (${status.runs} ${status.runs === 1 ? "run" : "runs"})`;
    case "budget":
      return `Criteria judged on ${status.runs} ${status.runs === 1 ? "run" : "runs"}; ${status.skipped} not judged (budget reached or the model failed)`;
  }
}
