// Re-runs the LLM judge on an existing results JSONL without touching the
// agent loop. Use this to:
//   - tighten the rubric (e.g. switch the no-criteria fallback from coherence
//     to strict) and re-score the same traces;
//   - swap the judge model (e.g. evaluate a Sonnet judge against a Haiku one);
//   - refresh judge verdicts after a corpus update that adds `judge_criteria`
//     to scenarios that didn't have it.
//
// Skips rows where `programmatic_verdict === "pass"` — the LLM judge was never
// meant to run on them (see `runner.ts` gating). Errors out fast when a
// scenario_id is missing from the corpus rather than silently emitting `n/a`.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LanguageModel } from "ai";
import { loadScenarios } from "./corpus.js";
import { appendJsonl, readJsonl, truncateJsonl } from "./io.js";
import { judgeLLM as defaultJudgeLLM, type JudgePromptVariant } from "./judges/llm.js";
import type { CellResult, Scenario } from "./types.js";

export interface RejudgeArgs {
  inputPath: string;
  outputPath: string;
  corpusPath: string;
  judgeModel: LanguageModel;
  /** Defaults to `"strict"` — same as the runner's default. */
  promptVariant?: JudgePromptVariant;
  /** Test injection point. */
  judge?: typeof defaultJudgeLLM;
}

export interface RejudgeSummary {
  /** Rows read from input. */
  total: number;
  /** Rows that went through the LLM judge. */
  rejudged: number;
  /** Rows passed through unchanged because programmatic_verdict was "pass". */
  skipped_pass: number;
  /** Rows written to output (== `total`). */
  written: number;
}

export async function rejudge(args: RejudgeArgs): Promise<RejudgeSummary> {
  const judge = args.judge ?? defaultJudgeLLM;
  const variant = args.promptVariant ?? "strict";

  const cells = readJsonl<CellResult>(args.inputPath);
  const scenarios = loadScenarios(args.corpusPath);
  const byId = new Map<string, Scenario>(scenarios.map((s) => [s.id, s]));

  mkdirSync(dirname(args.outputPath), { recursive: true });
  truncateJsonl(args.outputPath);

  let rejudged = 0;
  let skipped = 0;
  for (const cell of cells) {
    if (cell.programmatic_verdict === "pass") {
      appendJsonl(args.outputPath, cell);
      skipped++;
      continue;
    }
    const scenario = byId.get(cell.scenario_id);
    if (!scenario) {
      throw new Error(
        `rejudge: scenario "${cell.scenario_id}" not found in corpus ${args.corpusPath}. ` +
          `The results file may have been produced against a different corpus.`,
      );
    }
    const judged = await judge({
      prompt: scenario.prompt,
      judgeCriteria: scenario.judge_criteria,
      finalText: cell.final_text,
      model: args.judgeModel,
      promptVariant: variant,
    });
    cell.judge_verdict = judged.verdict;
    cell.judge_explanation = judged.explanation;
    appendJsonl(args.outputPath, cell);
    rejudged++;
  }

  return {
    total: cells.length,
    rejudged,
    skipped_pass: skipped,
    written: cells.length,
  };
}
