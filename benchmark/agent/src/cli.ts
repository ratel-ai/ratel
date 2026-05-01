// CLI entry. Wires AI SDK provider models to the runner. Default scenario corpus
// is the synthetic fixture so a smoke run works without ToolBench access.
//
// Required env: at least one of OPENAI_API_KEY (for gpt-5.4-mini) or
// ANTHROPIC_API_KEY (for claude-sonnet-4-6 + the LLM judge).

import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { config as loadEnv } from "dotenv";
import { resolveRepoPath } from "./paths.js";
import { type RunnerConfig, type RunnerModel, run } from "./runner.js";
import type { Arm } from "./types.js";

loadEnv();

interface ParsedArgs {
  corpus: string;
  output: string;
  scenarios?: number;
  arms: Arm[];
  models: string[];
  runs: number;
  topK: number;
  maxSteps: number;
  timeoutMs: number;
  dollarCell: number;
  dollarGlobal: number;
  force: boolean;
  noJudge: boolean;
  seed: number;
  logLevel: "quiet" | "normal" | "verbose";
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    corpus: "benchmark/test-data/synthetic.jsonl",
    output: "benchmark/agent/results/agent.jsonl",
    arms: ["control", "hybrid", "oracle"],
    models: ["gpt-5.4-mini", "claude-sonnet-4-6"],
    runs: 1,
    topK: 5,
    maxSteps: 12,
    timeoutMs: 60_000,
    dollarCell: 0.5,
    dollarGlobal: 25,
    force: false,
    noJudge: false,
    seed: 42,
    logLevel: "normal",
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${flag}`);
      return v;
    };
    switch (flag) {
      case "--corpus":
        args.corpus = next();
        break;
      case "--output":
        args.output = next();
        break;
      case "--scenarios":
        args.scenarios = Number(next());
        break;
      case "--arms":
        args.arms = next().split(",") as Arm[];
        break;
      case "--models":
        args.models = next().split(",");
        break;
      case "--runs":
        args.runs = Number(next());
        break;
      case "--top-k":
        args.topK = Number(next());
        break;
      case "--max-steps":
        args.maxSteps = Number(next());
        break;
      case "--timeout-ms":
        args.timeoutMs = Number(next());
        break;
      case "--dollar-cell":
        args.dollarCell = Number(next());
        break;
      case "--dollar-global":
        args.dollarGlobal = Number(next());
        break;
      case "--force":
        args.force = true;
        break;
      case "--no-judge":
        args.noJudge = true;
        break;
      case "--seed":
        args.seed = Number(next());
        break;
      case "--verbose":
      case "-v":
        args.logLevel = "verbose";
        break;
      case "--quiet":
      case "-q":
        args.logLevel = "quiet";
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  return args;
}

function resolveModel(modelId: string): RunnerModel {
  if (modelId.startsWith("claude")) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(`model ${modelId} requires ANTHROPIC_API_KEY (set in .env or shell)`);
    }
    return { id: modelId, model: anthropic(modelId) };
  }
  if (modelId.startsWith("gpt")) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(`model ${modelId} requires OPENAI_API_KEY`);
    }
    return { id: modelId, model: openai(modelId) };
  }
  throw new Error(`unknown model provider for: ${modelId}`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const models = parsed.models.map(resolveModel);
  const judgeModel = parsed.noJudge
    ? undefined
    : process.env.ANTHROPIC_API_KEY
      ? anthropic("claude-sonnet-4-6")
      : undefined;

  if (!parsed.noJudge && !judgeModel) {
    console.warn(
      "warn: ANTHROPIC_API_KEY not set; LLM-as-judge disabled (programmatic judge still active).",
    );
  }

  const cfg: RunnerConfig = {
    corpusPath: resolveRepoPath(parsed.corpus),
    outputPath: resolveRepoPath(parsed.output),
    scenarioLimit: parsed.scenarios,
    arms: parsed.arms,
    models,
    runsPerCell: parsed.runs,
    topK: parsed.topK,
    maxSteps: parsed.maxSteps,
    perRunTimeoutMs: parsed.timeoutMs,
    dollarCellCap: parsed.dollarCell,
    dollarGlobalCap: parsed.dollarGlobal,
    force: parsed.force,
    judgeModel,
    seed: parsed.seed,
    logLevel: parsed.logLevel,
  };

  console.log(
    `running ${parsed.arms.length} arms × ${models.length} models × ${parsed.runs} runs ` +
      `over ≤ ${parsed.scenarios ?? "all"} scenarios → ${parsed.output}`,
  );
  const summary = await run(cfg);
  console.log(
    `done: ${summary.cells_run} cells run, ${summary.cells_skipped} skipped, ` +
      `$${summary.total_dollars.toFixed(4)} spent, stopped=${summary.stopped_reason}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
