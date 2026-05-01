// Drives every (scenario, arm, model, run_index) cell, invoking the agent,
// metering it, judging the result, and writing one JSONL row per cell.
//
// Resumable: skips cells already present in the output JSONL unless `force` is
// set. Cost guards bound per-cell and global spend so a misconfigured catalog
// can't burn through the budget.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type LanguageModel, stepCountIs, ToolLoopAgent } from "ai";
import { type BuiltArm, buildArm } from "./arms.js";
import { loadScenarios } from "./corpus.js";
import { judgeLLM } from "./judges/llm.js";
import { judgeProgrammatic } from "./judges/programmatic.js";
import { type AgentLikeResult, meter, type PricingTable } from "./metering.js";
import type { Arm, CellResult, Scenario } from "./types.js";

export interface RunnerModel {
  /** Stable id used in the JSONL row (e.g. "gpt-5.4-mini"). Must match the pricing table. */
  id: string;
  /** AI SDK model instance. */
  model: LanguageModel;
}

export interface RunnerConfig {
  corpusPath: string;
  outputPath: string;
  scenarioLimit?: number;
  arms: Arm[];
  models: RunnerModel[];
  runsPerCell: number;
  topK: number;
  maxSteps: number;
  perRunTimeoutMs: number;
  dollarCellCap: number;
  dollarGlobalCap: number;
  force: boolean;
  judgeModel?: LanguageModel;
  seed: number;
  pricing?: PricingTable;
  /**
   * `quiet`   — only the final summary
   * `normal`  — one line per cell with verdict and error
   * `verbose` — also print the active tool ids and full tool-call trace
   */
  logLevel?: "quiet" | "normal" | "verbose";
  /** Optional injection point for tests: replaces the real agent execution. */
  runCell?: RunCellFn;
}

export type RunCellFn = (args: {
  scenario: Scenario;
  arm: Arm;
  builtArm: BuiltArm;
  model: RunnerModel;
  runIndex: number;
  config: RunnerConfig;
}) => Promise<CellResult>;

export interface RunnerSummary {
  cells_run: number;
  cells_skipped: number;
  scenarios: number;
  total_dollars: number;
  stopped_reason: "completed" | "global_cap" | "cell_cap";
}

interface CellKey {
  scenarioId: string;
  arm: Arm;
  model: string;
  runIndex: number;
}

function cellKeyString(k: CellKey): string {
  return `${k.scenarioId}::${k.arm}::${k.model}::${k.runIndex}`;
}

function readCompletedKeys(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const out = new Set<string>();
  const text = readFileSync(path, "utf-8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const cell = JSON.parse(line) as CellResult;
      out.add(
        cellKeyString({
          scenarioId: cell.scenario_id,
          arm: cell.arm,
          model: cell.model,
          runIndex: cell.run_index,
        }),
      );
    } catch {
      // Ignore malformed rows; resumability is best-effort.
    }
  }
  return out;
}

function appendRow(path: string, cell: CellResult): void {
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(path, `${existing}${sep}${JSON.stringify(cell)}\n`, "utf-8");
}

function verdictBadge(cell: CellResult): string {
  if (cell.error) return "ERROR";
  if (cell.programmatic_verdict === "pass") return "PASS";
  if (cell.programmatic_verdict === "fail") return "FAIL";
  if (cell.judge_verdict === "pass") return "PASS*";
  if (cell.judge_verdict === "fail") return "FAIL*";
  if (cell.judge_verdict === "partial") return "PART*";
  return "n/a";
}

function logCell(
  cell: CellResult,
  builtArm: BuiltArm,
  level: "quiet" | "normal" | "verbose",
): void {
  if (level === "quiet") return;
  const tag = `[${cell.scenario_id} · ${cell.arm} · ${cell.model} · #${cell.run_index}]`;
  const verdict = verdictBadge(cell);
  const tokens = `${cell.input_tokens}in/${cell.output_tokens}out`;
  const calls = `${cell.tool_calls_total} calls (${cell.gateway_calls} gw)`;
  const turns = `${cell.turns}t`;
  const finish = cell.finish_reason;
  const cost = `$${cell.dollar_cost.toFixed(4)}`;
  console.log(`${tag} ${verdict.padEnd(5)} ${tokens} ${calls} ${turns} ${finish} ${cost}`);
  if (cell.error) {
    console.log(`  ↳ error: ${cell.error}`);
  }
  if (level === "verbose") {
    console.log(`  ↳ active tools: ${builtArm.activeToolIds.join(", ") || "(none)"}`);
    if (cell.tool_calls.length > 0) {
      console.log(`  ↳ trace:`);
      for (const c of cell.tool_calls) {
        const args = JSON.stringify(c.args);
        const truncated = args.length > 120 ? `${args.slice(0, 117)}...` : args;
        console.log(`     - ${c.toolId}(${truncated})`);
      }
    }
    if (cell.effective_tool_ids.length > 0) {
      console.log(`  ↳ effective: ${cell.effective_tool_ids.join(", ")}`);
    }
    if (cell.final_text) {
      const text =
        cell.final_text.length > 200 ? `${cell.final_text.slice(0, 197)}...` : cell.final_text;
      console.log(`  ↳ final: ${text.replace(/\n/g, " ")}`);
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`run timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      (e) => {
        clearTimeout(id);
        reject(e);
      },
    );
  });
}

export async function defaultRunCell(args: {
  scenario: Scenario;
  arm: Arm;
  builtArm: BuiltArm;
  model: RunnerModel;
  runIndex: number;
  config: RunnerConfig;
}): Promise<CellResult> {
  const { scenario, arm, builtArm, model, runIndex, config } = args;
  const agent = new ToolLoopAgent({
    model: model.model,
    tools: builtArm.tools,
    toolChoice: "auto",
    stopWhen: stepCountIs(config.maxSteps),
  });

  const ctx = {
    scenarioId: scenario.id,
    arm,
    model: model.id,
    runIndex,
    catalogSize: builtArm.activeToolIds.length,
    seed: config.seed,
    nameToId: builtArm.nameToId,
  };

  const generate = async (): Promise<AgentLikeResult> => {
    const result = await withTimeout(
      agent.generate({ prompt: scenario.prompt }),
      config.perRunTimeoutMs,
    );
    return result as unknown as AgentLikeResult;
  };

  const { cell } = await meter(ctx, generate, config.pricing);

  const programmatic = judgeProgrammatic(scenario.gold_trace, cell.effective_tool_ids);
  cell.programmatic_verdict = programmatic.verdict;

  // Run LLM judge as a tiebreaker / fallback when programmatic gives no signal.
  if (config.judgeModel && (programmatic.verdict === "n/a" || programmatic.verdict === "fail")) {
    const judged = await judgeLLM({
      judgeCriteria: scenario.judge_criteria ?? "",
      finalText: cell.final_text,
      model: config.judgeModel,
    });
    cell.judge_verdict = judged.verdict;
  }
  return cell;
}

export async function run(config: RunnerConfig): Promise<RunnerSummary> {
  const scenarios = loadScenarios(config.corpusPath).slice(
    0,
    config.scenarioLimit ?? Number.POSITIVE_INFINITY,
  );

  mkdirSync(dirname(config.outputPath), { recursive: true });
  if (config.force && existsSync(config.outputPath)) {
    // Truncate so re-runs don't append duplicates onto previous cells.
    writeFileSync(config.outputPath, "", "utf-8");
  }
  const completed = config.force ? new Set<string>() : readCompletedKeys(config.outputPath);

  let cellsRun = 0;
  let cellsSkipped = 0;
  let totalDollars = 0;
  let stopped: RunnerSummary["stopped_reason"] = "completed";

  outer: for (const scenario of scenarios) {
    for (const arm of config.arms) {
      const builtArm = buildArm(arm, scenario, config.topK);
      for (const model of config.models) {
        let cellDollars = 0;
        for (let runIndex = 0; runIndex < config.runsPerCell; runIndex++) {
          const key = cellKeyString({
            scenarioId: scenario.id,
            arm,
            model: model.id,
            runIndex,
          });
          if (completed.has(key)) {
            cellsSkipped++;
            continue;
          }
          if (totalDollars >= config.dollarGlobalCap) {
            stopped = "global_cap";
            break outer;
          }
          if (cellDollars >= config.dollarCellCap) {
            stopped = "cell_cap";
            break;
          }
          const runCellFn = config.runCell ?? defaultRunCell;
          const cell = await runCellFn({
            scenario,
            arm,
            builtArm,
            model,
            runIndex,
            config,
          });
          appendRow(config.outputPath, cell);
          cellsRun++;
          cellDollars += cell.dollar_cost;
          totalDollars += cell.dollar_cost;
          logCell(cell, builtArm, config.logLevel ?? "normal");
        }
      }
    }
  }

  return {
    cells_run: cellsRun,
    cells_skipped: cellsSkipped,
    scenarios: scenarios.length,
    total_dollars: totalDollars,
    stopped_reason: stopped,
  };
}
