// LLM-as-judge — primary correctness signal for mode (c) when no programmatic
// `gold_trace` exists (the v0.1.1 corpora ship gold ids only). Sees ONLY the
// user prompt, the assistant's final text, and (optionally) a curated success
// criteria — never the trace, never the gold tools. That invariant from
// ADR-0005 prevents the judge from reverse-engineering the verdict from
// observed calls; it has to evaluate the answer on its own merits.
//
// MetaTool scenarios don't carry `judge_criteria`, so the judge falls back to
// scoring "does the assistant's final text coherently address the user's
// request?" — a coherence check, not a full task-completion check. ADR-0006
// accepts this softness because the headline claim for v0.1.1 is "tokens at
// equal selection accuracy," carried by the programmatic judge.

import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import type { JudgeVerdict } from "../types.js";

const VerdictSchema = z.object({
  verdict: z.enum(["pass", "fail", "partial"]),
  explanation: z.string(),
});

export interface LLMJudgeArgs {
  /** The user's original prompt — used for the coherence-fallback path when no criteria is provided. */
  prompt: string;
  /** Optional curated success criteria. When empty, the judge scores coherence against `prompt`. */
  judgeCriteria?: string;
  finalText: string;
  model: LanguageModel;
}

export interface LLMJudgeResult {
  verdict: JudgeVerdict;
  explanation: string;
}

const SYSTEM_WITH_CRITERIA = [
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

const SYSTEM_PROMPT_ONLY = [
  "You are an impartial evaluator of an AI assistant's final response.",
  "You will be given:",
  "  1. USER_REQUEST — what the user asked the assistant to do.",
  "  2. ASSISTANT_OUTPUT — the assistant's final text.",
  "Decide whether the assistant's output coherently addresses the user's request:",
  "  - 'pass'   = the output substantively addresses the request",
  "  - 'partial'= partially on-topic but incomplete or off-target",
  "  - 'fail'   = ignores the request, is empty/error, or is incoherent",
  "Don't penalize the assistant for not naming a particular tool or for stub-shaped",
  "tool responses — judge the coherence and relevance of the final text only.",
  "You do NOT see what tools were called, only the final text.",
].join("\n");

export async function judgeLLM(args: LLMJudgeArgs): Promise<LLMJudgeResult> {
  const criteria = args.judgeCriteria?.trim() ?? "";
  const finalText = args.finalText.trim().length === 0 ? "(empty)" : args.finalText;

  const { system, userPrompt } =
    criteria.length > 0
      ? {
          system: SYSTEM_WITH_CRITERIA,
          userPrompt: ["SUCCESS_CRITERIA:", criteria, "", "ASSISTANT_OUTPUT:", finalText].join(
            "\n",
          ),
        }
      : {
          system: SYSTEM_PROMPT_ONLY,
          userPrompt: ["USER_REQUEST:", args.prompt, "", "ASSISTANT_OUTPUT:", finalText].join("\n"),
        };

  try {
    const { object } = await generateObject({
      model: args.model,
      schema: VerdictSchema,
      system,
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
