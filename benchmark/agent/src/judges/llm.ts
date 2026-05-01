// LLM-as-judge — invoked when the programmatic verdict is "n/a", or as a
// secondary tiebreaker. The judge sees ONLY (criteria, final text) — never the
// trace — so it can't reverse-engineer the answer from observed calls (per
// ADR-0005).

import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import type { JudgeVerdict } from "../types.js";

const VerdictSchema = z.object({
  verdict: z.enum(["pass", "fail", "partial"]),
  explanation: z.string(),
});

export interface LLMJudgeArgs {
  judgeCriteria: string;
  finalText: string;
  model: LanguageModel;
}

export interface LLMJudgeResult {
  verdict: JudgeVerdict;
  explanation: string;
}

const SYSTEM = [
  "You are an impartial evaluator of an AI assistant's final response.",
  "You will be given:",
  "  1. SUCCESS_CRITERIA — what the assistant should have communicated.",
  "  2. ASSISTANT_OUTPUT — the assistant's final text.",
  "Decide whether the assistant's output meets the criteria:",
  "  - 'pass'   = clearly meets the criteria",
  "  - 'partial'= partially meets, but missing or wrong on some aspect",
  "  - 'fail'   = does not meet the criteria, or output is empty/error",
  "Be strict — wording variation is fine, but missing the substantive answer is a fail.",
  "You do NOT see what tools were called, only the final text.",
].join("\n");

export async function judgeLLM(args: LLMJudgeArgs): Promise<LLMJudgeResult> {
  if (!args.judgeCriteria || args.judgeCriteria.trim().length === 0) {
    return { verdict: "n/a", explanation: "no judge criteria for this scenario" };
  }
  const userPrompt = [
    "SUCCESS_CRITERIA:",
    args.judgeCriteria,
    "",
    "ASSISTANT_OUTPUT:",
    args.finalText.trim().length === 0 ? "(empty)" : args.finalText,
  ].join("\n");

  try {
    const { object } = await generateObject({
      model: args.model,
      schema: VerdictSchema,
      system: SYSTEM,
      prompt: userPrompt,
    });
    return { verdict: object.verdict, explanation: object.explanation };
  } catch (err) {
    return {
      verdict: "n/a",
      explanation: `judge failed: ${(err as Error).message ?? String(err)}`,
    };
  }
}
