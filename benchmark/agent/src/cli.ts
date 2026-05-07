// CLI entry. Wires AI SDK provider models to the runner. Default scenario
// corpus is the ingested MetaTool snapshot, which `pnpm -F @ratel-ai/benchmark
// run-all` produces from a clean clone.
//
// Required env: at least one of OPENAI_API_KEY (for gpt-*) or
// ANTHROPIC_API_KEY (for claude-* + the default LLM judge). Local models via
// Ollama need no key — the `ollama:` prefix routes through the local server's
// OpenAI-compatible endpoint (http://localhost:11434/v1 by default). Examples:
//   --models ollama:qwen3.5,ollama:gemma4
//   --judge-model ollama:qwen3.5         (cost-free judge)

import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAI, openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { config as loadEnv } from "dotenv";
import type { JudgePromptVariant } from "./judges/llm.js";
import { resolveRepoPath } from "./paths.js";
import { rejudge } from "./rejudge.js";
import { loadAgentRegistry, type RunnerConfig, type RunnerModel, run } from "./runner.js";
import type { Arm } from "./types.js";

loadEnv();

const OLLAMA_PREFIX = "ollama:";
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";

/** Default arms when `--arms` isn't passed: every committed arm. The local-only
 * `claude-sdk-tool-search` is included automatically by the registry but
 * excluded from the default list — opt in via `--arms` once it's wired locally. */
const DEFAULT_ARMS: Arm[] = [
  "control-baseline",
  "control-oracle",
  "ratel-full",
  "ratel-pre-discovery",
  "ratel-discovery-tool",
];

/** Old → new id hints for the rename in v0.1.2. Pre-empts a confusing
 * `unknown arm` error when developers re-run an older command. */
const RENAMES: Record<string, string> = {
  control: "control-baseline",
  oracle: "control-oracle",
  ratel: "ratel-full",
  hybrid: "ratel-full",
};

/**
 * Parse + validate the `--arms` value against the registry. Bad input used to
 * flow through `as Arm[]` and crash deep in the runner with a useless
 * TypeError; this surface validates at the boundary and surfaces both the
 * legacy → new id rename and the full set of known ids.
 */
function parseArms(raw: string, knownArms: readonly string[]): Arm[] {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) throw new Error("--arms must list at least one arm");
  const out: Arm[] = [];
  for (const p of parts) {
    if (knownArms.includes(p)) {
      out.push(p);
      continue;
    }
    if (RENAMES[p]) {
      throw new Error(
        `--arms: "${p}" was renamed to "${RENAMES[p]}". Update your command to ` +
          `--arms ${DEFAULT_ARMS.join(",")} (or whichever subset you want).`,
      );
    }
    throw new Error(`--arms: unknown arm "${p}" (expected one of: ${knownArms.join(", ")})`);
  }
  return out;
}

/**
 * Parse a single positive integer for `--pool-size`. Rejects commas explicitly
 * so a `--pool-size 30,50,100` typo points the user at `--pool-sizes`
 * instead of silently flowing `NaN` through to `expandPool` (which would
 * collapse the catalog to gold-only).
 */
function parsePoolSize(flag: string, raw: string): number {
  if (raw.includes(",")) {
    throw new Error(
      `${flag} takes a single integer (got "${raw}"). Use --pool-sizes for a comma-separated sweep.`,
    );
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(`${flag} must be a positive integer (got "${raw}")`);
  }
  return n;
}

/** Parse `--pool-sizes 30,50,100` into a deduped, sorted list of positive integers. */
function parsePoolSizes(raw: string): number[] {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) throw new Error("--pool-sizes must list at least one integer");
  const seen = new Set<number>();
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      throw new Error(`--pool-sizes: "${p}" is not a positive integer`);
    }
    seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

interface ParsedArgs {
  corpus: string;
  output: string;
  outputExplicit: boolean;
  ephemeral: boolean;
  scenarios?: number;
  arms: Arm[];
  models: string[];
  runs: number;
  topK: number;
  poolSizes: number[];
  maxSteps: number;
  timeoutMs: number;
  dollarGlobal: number;
  force: boolean;
  noJudge: boolean;
  /** Override the LLM judge model. Defaults to claude-sonnet-4-6 if ANTHROPIC_API_KEY is set. */
  judgeModelId?: string;
  ollamaBaseURL: string;
  seed: number;
  /** Cells in flight at once. See `RunnerConfig.concurrency` for cap semantics. */
  concurrency: number;
  logLevel: "quiet" | "normal" | "verbose";
}

function parseArgs(argv: string[], knownArms: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {
    corpus: "benchmark/test-data/metatool.jsonl",
    output: "benchmark/agent/results/agent.jsonl",
    outputExplicit: false,
    ephemeral: false,
    arms: [...DEFAULT_ARMS],
    models: ["gpt-5.4-mini", "claude-sonnet-4-6"],
    runs: 1,
    topK: 5,
    poolSizes: [180],
    maxSteps: 12,
    timeoutMs: 60_000,
    dollarGlobal: 25,
    force: false,
    noJudge: false,
    ollamaBaseURL: process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL,
    seed: 42,
    concurrency: 10,
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
        args.outputExplicit = true;
        break;
      case "--ephemeral":
        args.ephemeral = true;
        break;
      case "--scenarios":
        args.scenarios = Number(next());
        break;
      case "--arms":
        args.arms = parseArms(next(), knownArms);
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
      case "--pool-size":
        args.poolSizes = [parsePoolSize(flag, next())];
        break;
      case "--pool-sizes":
        args.poolSizes = parsePoolSizes(next());
        break;
      case "--max-steps":
        args.maxSteps = Number(next());
        break;
      case "--timeout-ms":
        args.timeoutMs = Number(next());
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
      case "--judge-model":
        args.judgeModelId = next();
        break;
      case "--ollama-base-url":
        args.ollamaBaseURL = next();
        break;
      case "--seed":
        args.seed = Number(next());
        break;
      case "--concurrency": {
        const n = Number(next());
        if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
          throw new Error(`--concurrency must be a positive integer, got ${n}`);
        }
        args.concurrency = n;
        break;
      }
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

interface ResolveOpts {
  ollamaBaseURL: string;
}

/**
 * Resolve an Ollama model id (e.g. `ollama:qwen3.5`) into a Vercel AI SDK
 * `LanguageModel` that talks to the local Ollama server via its OpenAI-
 * compatible endpoint. The model id stored on the cell row keeps the
 * `ollama:` prefix so reports clearly distinguish local vs cloud models.
 *
 * Tool calling depends on the underlying model's native function-calling
 * support — Qwen / Llama families work well; Gemma is hit-or-miss. If a
 * local-model cell consistently logs zero tool calls, the model likely
 * isn't function-calling and the run is mainly measuring "did the model
 * write a coherent answer." That's still informative — just call it out
 * when reading the report.
 */
function resolveOllama(modelTag: string, baseURL: string): RunnerModel {
  // `.chat(...)` forces the legacy `/v1/chat/completions` wire format. The
  // default factory call uses OpenAI's newer Responses API (typed items like
  // `item_reference`), which Ollama's OpenAI-compat endpoint doesn't speak.
  const provider = createOpenAI({ baseURL, apiKey: "ollama" });
  return { id: `${OLLAMA_PREFIX}${modelTag}`, model: provider.chat(modelTag) };
}

function resolveModel(modelId: string, opts: ResolveOpts): RunnerModel {
  if (modelId.startsWith(OLLAMA_PREFIX)) {
    return resolveOllama(modelId.slice(OLLAMA_PREFIX.length), opts.ollamaBaseURL);
  }
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
  throw new Error(
    `unknown model provider for: ${modelId} ` +
      `(expected gpt-*, claude-*, or ${OLLAMA_PREFIX}<tag>)`,
  );
}

/**
 * Pick the LLM judge model. `--no-judge` always wins. With `--judge-model X`
 * the user picks any provider (including `ollama:*`); without it the default
 * is Sonnet when ANTHROPIC_API_KEY is set, else no LLM judge (programmatic
 * judge still runs).
 */
function resolveJudge(parsed: ParsedArgs): LanguageModel | undefined {
  if (parsed.noJudge) return undefined;
  if (parsed.judgeModelId) {
    return resolveModel(parsed.judgeModelId, { ollamaBaseURL: parsed.ollamaBaseURL }).model;
  }
  if (process.env.ANTHROPIC_API_KEY) return anthropic("claude-sonnet-4-6");
  return undefined;
}

/**
 * `--ephemeral` writes to a fresh per-run file under
 * `benchmark/agent/results/ephemeral/<UTC-timestamp>.jsonl` instead of the
 * shared `agent.jsonl`. Designed for smoke tests / one-off campaigns where
 * the developer doesn't want to clobber the canonical output and shouldn't
 * have to think about `--force`. Conflicts with an explicit `--output`.
 */
function ephemeralOutputPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `benchmark/agent/results/ephemeral/agent-${stamp}.jsonl`;
}

/** Canonical agent.jsonl that ephemeral runs read for cached control rows. */
const CANONICAL_AGENT_JSONL = "benchmark/agent/results/agent.jsonl";

interface RejudgeParsedArgs {
  input: string;
  corpus: string;
  judgeModelId?: string;
  promptVariant: JudgePromptVariant;
  out?: string;
  ollamaBaseURL: string;
}

function parseRejudgeArgs(argv: string[]): RejudgeParsedArgs {
  const args: RejudgeParsedArgs = {
    input: "",
    corpus: "benchmark/test-data/metatool.jsonl",
    promptVariant: "strict",
    ollamaBaseURL: process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL,
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
      case "--judge-model":
        args.judgeModelId = next();
        break;
      case "--judge-prompt": {
        const v = next();
        if (v !== "coherence" && v !== "strict") {
          throw new Error(`--judge-prompt must be "coherence" or "strict", got "${v}"`);
        }
        args.promptVariant = v;
        break;
      }
      case "--out":
        args.out = next();
        break;
      case "--ollama-base-url":
        args.ollamaBaseURL = next();
        break;
      default:
        if (flag.startsWith("-")) {
          throw new Error(`unknown flag for rejudge: ${flag}`);
        }
        if (args.input) {
          throw new Error(`rejudge takes a single input JSONL (got "${args.input}" and "${flag}")`);
        }
        args.input = flag;
    }
  }
  if (!args.input) {
    throw new Error(
      "rejudge: missing input JSONL. Usage:\n" +
        "  pnpm start rejudge <results.jsonl> [--corpus PATH] [--judge-model ID] " +
        "[--judge-prompt coherence|strict] [--out PATH]",
    );
  }
  return args;
}

/** Default output path: `<input>.rejudged-<variant>.jsonl`, alongside the source. */
function defaultRejudgeOutput(input: string, variant: JudgePromptVariant): string {
  const dotJsonl = input.endsWith(".jsonl") ? input.slice(0, -".jsonl".length) : input;
  return `${dotJsonl}.rejudged-${variant}.jsonl`;
}

async function rejudgeMain(argv: string[]): Promise<void> {
  const parsed = parseRejudgeArgs(argv);
  const judgeModelId = parsed.judgeModelId ?? "claude-sonnet-4-6";
  const judgeModel = resolveModel(judgeModelId, { ollamaBaseURL: parsed.ollamaBaseURL }).model;

  const inputPath = resolveRepoPath(parsed.input);
  const outputPath = resolveRepoPath(
    parsed.out ?? defaultRejudgeOutput(parsed.input, parsed.promptVariant),
  );
  const corpusPath = resolveRepoPath(parsed.corpus);

  console.log(
    `rejudging ${inputPath} with ${judgeModelId} (${parsed.promptVariant}) → ${outputPath}`,
  );
  const summary = await rejudge({
    inputPath,
    outputPath,
    corpusPath,
    judgeModel,
    promptVariant: parsed.promptVariant,
  });
  console.log(
    `done: ${summary.total} rows (${summary.rejudged} rejudged, ` +
      `${summary.skipped_pass} kept as programmatic-pass).`,
  );
}

async function runMain(): Promise<void> {
  const registry = await loadAgentRegistry();
  const knownArms = [...registry.keys()];
  const parsed = parseArgs(process.argv.slice(2), knownArms);
  let cacheSourcePath: string | undefined;
  if (parsed.ephemeral) {
    if (parsed.outputExplicit) {
      throw new Error("--ephemeral and --output are mutually exclusive");
    }
    parsed.output = ephemeralOutputPath();
    cacheSourcePath = resolveRepoPath(CANONICAL_AGENT_JSONL);
  }
  const resolveOpts: ResolveOpts = { ollamaBaseURL: parsed.ollamaBaseURL };
  const models = parsed.models.map((m) => resolveModel(m, resolveOpts));
  const judgeModel = resolveJudge(parsed);

  if (!parsed.noJudge && !judgeModel) {
    console.warn(
      "warn: no LLM judge configured (set ANTHROPIC_API_KEY or pass --judge-model); " +
        "programmatic judge still active.",
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
    poolSizes: parsed.poolSizes,
    maxSteps: parsed.maxSteps,
    perRunTimeoutMs: parsed.timeoutMs,
    dollarGlobalCap: parsed.dollarGlobal,
    force: parsed.force,
    judgeModel,
    seed: parsed.seed,
    concurrency: parsed.concurrency,
    logLevel: parsed.logLevel,
    registry,
    cacheSourcePath,
  };

  console.log(
    `running ${parsed.arms.length} arms × ${models.length} models × ${parsed.runs} runs ` +
      `× ${parsed.poolSizes.length} pool size(s) [${parsed.poolSizes.join(",")}] ` +
      `over ≤ ${parsed.scenarios ?? "all"} scenarios at concurrency=${parsed.concurrency} ` +
      `→ ${parsed.output}`,
  );
  const summary = await run(cfg);
  console.log(
    `done: ${summary.cells_run} cells run, ${summary.cells_cached} cached, ` +
      `${summary.cells_skipped} skipped, $${summary.total_dollars.toFixed(4)} spent, ` +
      `stopped=${summary.stopped_reason}`,
  );
}

async function main(): Promise<void> {
  const subcommand = process.argv[2];
  if (subcommand === "rejudge") {
    await rejudgeMain(process.argv.slice(3));
    return;
  }
  await runMain();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
