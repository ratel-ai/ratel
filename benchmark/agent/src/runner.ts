// Drives every (scenario, arm, model, run_index) cell, invoking the agent,
// metering it, judging the result, and writing one JSONL row per cell.
//
// Resumable: skips cells already present in the output JSONL unless `force` is
// set. Cost guards bound per-cell and global spend so a misconfigured catalog
// can't burn through the budget.
//
// The corpora ship per-scenario `candidate_pool` containing only the gold
// tools; the runner pools distractors from other scenarios at startup
// (`buildToolUniverse`) and synthesizes per-scenario pools at the configured
// `poolSize` (`expandPool`). Same pool drives every arm in a cell so the
// "fat baseline vs Ratel" comparison is fair.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type LanguageModel, stepCountIs, ToolLoopAgent } from "ai";
import { type BuiltArm, buildArm } from "./arms.js";
import { loadScenarios } from "./corpus.js";
import { judgeLLM } from "./judges/llm.js";
import { judgeProgrammatic } from "./judges/programmatic.js";
import { type AgentLikeResult, meter, type PricingTable } from "./metering.js";
import { buildToolUniverse, expandPool } from "./pool.js";
import type { Arm, CellResult, Scenario, ToolSpec } from "./types.js";

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
  /** Total tools per scenario (gold + distractors). The catalog size every arm ranks against. */
  poolSize: number;
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
  /**
   * How many cells run in parallel. Cells are independent (per-cell catalogs,
   * fresh agent per call) so the only shared state is the JSONL output and the
   * accumulators — both serialized inside synchronous boundaries. Default 1
   * preserves the legacy single-threaded ordering for tests; the CLI defaults
   * to 10 because the benchmark is wall-clock-bound on provider latency.
   *
   * Dollar caps are best-effort under concurrency: when a cap fires, in-flight
   * cells finish but no new ones start, so overshoot is bounded by
   * `concurrency × max_cell_cost`.
   */
  concurrency?: number;
  /** Optional injection point for tests: replaces the real agent execution. */
  runCell?: RunCellFn;
}

export type RunCellFn = (args: {
  scenario: Scenario;
  arm: Arm;
  builtArm: BuiltArm;
  model: RunnerModel;
  runIndex: number;
  poolSize: number;
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

/**
 * Single-syscall append. Synchronous on purpose: the JS event loop guarantees
 * no two `appendRow` calls interleave even when multiple workers are in flight
 * (each worker awaits the agent, then writes synchronously), so no extra
 * mutex is needed. O(1) per call — important once the JSONL grows past a few
 * thousand rows.
 *
 * Exported for direct testing of the append path; production callers go
 * through `run`.
 */
export function appendRow(path: string, cell: CellResult): void {
  appendFileSync(path, `${JSON.stringify(cell)}\n`, "utf-8");
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
  done?: number,
  total?: number,
): void {
  if (level === "quiet") return;
  const counter = done !== undefined && total !== undefined ? `[${done}/${total}] ` : "";
  const tag = `${counter}[${cell.scenario_id} · ${cell.arm} · ${cell.model} · #${cell.run_index}]`;
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
  poolSize: number;
  config: RunnerConfig;
}): Promise<CellResult> {
  const { scenario, arm, builtArm, model, runIndex, poolSize, config } = args;
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
    poolSize,
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

  const programmatic = judgeProgrammatic(scenario.gold_tools, cell.effective_tool_ids);
  cell.programmatic_verdict = programmatic.verdict;

  // Run LLM judge as a tiebreaker / fallback when programmatic gives no signal,
  // or as a coherence check on top of a programmatic fail.
  if (config.judgeModel && (programmatic.verdict === "n/a" || programmatic.verdict === "fail")) {
    const judged = await judgeLLM({
      prompt: scenario.prompt,
      judgeCriteria: scenario.judge_criteria,
      finalText: cell.final_text,
      model: config.judgeModel,
    });
    cell.judge_verdict = judged.verdict;
  }
  return cell;
}

/**
 * Seeded shuffle so a `--scenarios N` subset is representative of the full
 * corpus rather than an id-sorted prefix (which on MetaTool would cluster all
 * `metatool-mt-*` rows at the head). Same `seed` reproduces the same subset
 * across runs — important for resume.
 */
function sampleScenarios(
  scenarios: Scenario[],
  limit: number | undefined,
  seed: number,
): Scenario[] {
  if (limit === undefined || limit >= scenarios.length) return scenarios;
  const shuffled = [...scenarios];
  let h = seed >>> 0;
  // Fisher-Yates with a mulberry32 PRNG seeded from `seed`.
  const rng = () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, limit);
}

interface PendingTask {
  scenario: Scenario;
  arm: Arm;
  builtArm: BuiltArm;
  model: RunnerModel;
  runIndex: number;
  expandedPool: ToolSpec[];
  /** Key into `cellDollarsByGroup` — accumulated cost per (scenario, model). */
  cellGroupKey: string;
}

/**
 * Materializes the full task list ahead of time so the worker pool has a flat
 * queue to consume. Pre-built `BuiltArm` and expanded pool are shared across
 * runs of the same (scenario, arm) — both are pure derivations of inputs, so
 * sharing them is safe and saves repeated work.
 *
 * Already-completed cells are filtered out here. The order is the same as the
 * legacy nested loop (scenarios × arms × models × runs); workers pick from
 * the head of the queue, so at concurrency=1 behavior is byte-identical to the
 * pre-parallel runner.
 */
function buildTaskQueue(
  scenarios: Scenario[],
  universe: ReturnType<typeof buildToolUniverse>,
  config: RunnerConfig,
  completed: Set<string>,
): { tasks: PendingTask[]; cellsSkipped: number } {
  const tasks: PendingTask[] = [];
  let cellsSkipped = 0;
  for (const scenario of scenarios) {
    const expandedPool = expandPool(scenario, universe, config.poolSize, config.seed);
    for (const arm of config.arms) {
      const builtArm = buildArm(arm, scenario, expandedPool, config.topK);
      for (const model of config.models) {
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
          tasks.push({
            scenario,
            arm,
            builtArm,
            model,
            runIndex,
            expandedPool,
            cellGroupKey: `${scenario.id}::${model.id}`,
          });
        }
      }
    }
  }
  return { tasks, cellsSkipped };
}

export async function run(config: RunnerConfig): Promise<RunnerSummary> {
  const allScenarios = loadScenarios(config.corpusPath);
  const scenarios = sampleScenarios(allScenarios, config.scenarioLimit, config.seed);

  // Universe is built from the full corpus, not the sampled subset, so smaller
  // runs still have a realistic distractor population to draw from.
  const universe = buildToolUniverse(allScenarios);

  mkdirSync(dirname(config.outputPath), { recursive: true });
  if (config.force && existsSync(config.outputPath)) {
    // Truncate so re-runs don't append duplicates onto previous cells.
    writeFileSync(config.outputPath, "", "utf-8");
  }
  const completed = config.force ? new Set<string>() : readCompletedKeys(config.outputPath);

  const { tasks, cellsSkipped: initialSkipped } = buildTaskQueue(
    scenarios,
    universe,
    config,
    completed,
  );

  const concurrency = Math.max(1, Math.floor(config.concurrency ?? 1));
  const runCellFn = config.runCell ?? defaultRunCell;
  const logLevel = config.logLevel ?? "normal";

  let cellsRun = 0;
  let totalDollars = 0;
  let stopped: RunnerSummary["stopped_reason"] = "completed";
  const cellDollarsByGroup = new Map<string, number>();
  let nextTaskIdx = 0;

  // Pick the next runnable task, or `null` if the queue is drained / a cap
  // has fired. Synchronous; safe to call from any worker because the JS event
  // loop guarantees no preemption between the read and the increment.
  const pickTask = (): PendingTask | null => {
    if (stopped !== "completed") return null;
    if (totalDollars >= config.dollarGlobalCap) {
      stopped = "global_cap";
      return null;
    }
    while (nextTaskIdx < tasks.length) {
      const t = tasks[nextTaskIdx++];
      const groupSpend = cellDollarsByGroup.get(t.cellGroupKey) ?? 0;
      if (groupSpend >= config.dollarCellCap) {
        // The (scenario, model) tuple has already burned its budget. Skip
        // remaining runs for it but keep going on other tuples — same shape
        // as the legacy `break` of the inner runs loop.
        stopped = stopped === "completed" ? "cell_cap" : stopped;
        continue;
      }
      return t;
    }
    return null;
  };

  const totalToRun = tasks.length;
  const worker = async (): Promise<void> => {
    while (true) {
      const task = pickTask();
      if (!task) return;
      const cell = await runCellFn({
        scenario: task.scenario,
        arm: task.arm,
        builtArm: task.builtArm,
        model: task.model,
        runIndex: task.runIndex,
        poolSize: task.expandedPool.length,
        config,
      });
      // Synchronous tail: append + counters happen without yielding, so two
      // workers cannot interleave their writes or accumulator updates.
      appendRow(config.outputPath, cell);
      cellsRun++;
      totalDollars += cell.dollar_cost;
      cellDollarsByGroup.set(
        task.cellGroupKey,
        (cellDollarsByGroup.get(task.cellGroupKey) ?? 0) + cell.dollar_cost,
      );
      logCell(cell, task.builtArm, logLevel, cellsRun, totalToRun);
      if (totalDollars >= config.dollarGlobalCap) {
        stopped = "global_cap";
      }
    }
  };

  const workerCount = Math.min(concurrency, Math.max(1, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return {
    cells_run: cellsRun,
    cells_skipped: initialSkipped,
    scenarios: scenarios.length,
    total_dollars: totalDollars,
    stopped_reason: stopped,
  };
}
