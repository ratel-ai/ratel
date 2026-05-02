// Drives every (scenario, arm, model, run_index) cell, dispatching the agent
// run through the registry, judging the result, and writing one JSONL row
// per cell.
//
// Resumable: skips cells already present in the output JSONL unless `force` is
// set. Cost guards bound per-cell and global spend so a misconfigured catalog
// can't burn through the budget.
//
// Each arm is an `AgentDescriptor` defined in its own file under `agents/`;
// the runner doesn't know how to build tools — it only knows how to schedule
// cells, hand the descriptor an `AgentRunInput`, judge the result, and
// persist it. Registry composition: two control arms statically registered,
// plus every `*.ts` file under `agents/non-control/` (auto-discovered;
// `ignore.*` filenames are gitignored so each developer can drop local-only
// arms next to the committed ones).

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LanguageModel } from "ai";
import { descriptor as controlBaseline } from "./agents/control-baseline.js";
import { descriptor as controlOracle } from "./agents/control-oracle.js";
import { loadScenarios } from "./corpus.js";
import { judgeLLM } from "./judges/llm.js";
import { judgeProgrammatic } from "./judges/programmatic.js";
import type { PricingTable } from "./metering.js";
import { buildToolUniverse, expandPool } from "./pool.js";
import type { AgentDescriptor, Arm, CellResult, Scenario, ToolSpec } from "./types.js";

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
   * `verbose` — also print the tool-call trace
   */
  logLevel?: "quiet" | "normal" | "verbose";
  /**
   * How many cells run in parallel. Cells are independent (each agent builds
   * its own catalog, fresh agent per call) so the only shared state is the
   * JSONL output and the accumulators — both serialized inside synchronous
   * boundaries. Default 1 preserves the legacy single-threaded ordering for
   * tests; the CLI defaults to 10 because the benchmark is wall-clock-bound
   * on provider latency.
   *
   * Dollar caps are best-effort under concurrency: when a cap fires, in-flight
   * cells finish but no new ones start, so overshoot is bounded by
   * `concurrency × max_cell_cost`.
   */
  concurrency?: number;
  /** Optional injection point for tests: replaces the real agent dispatch. */
  runCell?: RunCellFn;
  /**
   * Optional pre-built registry. When omitted (the production path), `run()`
   * builds one via `loadAgentRegistry()`. Tests that exercise the runner
   * orchestration without touching real agents inject `runCell` and skip the
   * registry entirely.
   */
  registry?: Map<string, AgentDescriptor>;
}

export type RunCellFn = (args: {
  scenario: Scenario;
  arm: Arm;
  model: RunnerModel;
  runIndex: number;
  pool: ToolSpec[];
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

/**
 * Build the agent registry: two control arms statically wired, plus every
 * `*.ts` file under `agents/non-control/` (excluding `.test.ts`, `.d.ts`,
 * filenames starting with `_`, and the `ignore.*` rule's targets when the
 * file is gitignored — those still get picked up locally because the rule
 * only filters git, not the filesystem). Each non-control file must
 * `export const descriptor: AgentDescriptor` with a unique `id`.
 *
 * Exported for direct testing of the discovery logic.
 */
export async function loadAgentRegistry(): Promise<Map<string, AgentDescriptor>> {
  const registry = new Map<string, AgentDescriptor>();
  registerDescriptor(registry, controlBaseline, "<static>");
  registerDescriptor(registry, controlOracle, "<static>");

  const moduleUrl = new URL("./agents/non-control/", import.meta.url);
  const dir = fileURLToPath(moduleUrl);
  if (!existsSync(dir)) return registry;

  for (const entry of readdirSync(dir)) {
    if (!isAgentFile(entry)) continue;
    const fileUrl = pathToFileURL(`${dir}${entry}`).href;
    const mod = (await import(fileUrl)) as { descriptor?: AgentDescriptor };
    if (!mod.descriptor) {
      throw new Error(
        `agents/non-control/${entry}: missing \`export const descriptor\` (AgentDescriptor)`,
      );
    }
    registerDescriptor(registry, mod.descriptor, entry);
  }
  return registry;
}

function isAgentFile(name: string): boolean {
  if (!name.endsWith(".ts") && !name.endsWith(".js")) return false;
  if (name.endsWith(".test.ts") || name.endsWith(".test.js")) return false;
  if (name.endsWith(".d.ts")) return false;
  if (name.startsWith("_")) return false;
  return true;
}

function registerDescriptor(
  registry: Map<string, AgentDescriptor>,
  desc: AgentDescriptor,
  source: string,
): void {
  if (!desc.id || !desc.label || typeof desc.run !== "function") {
    throw new Error(
      `${source}: descriptor must have non-empty id+label and a run() function (got ${JSON.stringify(
        { id: desc.id, label: desc.label, hasRun: typeof desc.run === "function" },
      )})`,
    );
  }
  if (registry.has(desc.id)) {
    throw new Error(
      `agent registry: duplicate descriptor id "${desc.id}" (second registration from ${source})`,
    );
  }
  registry.set(desc.id, desc);
}

/**
 * Default cell runner: looks up the descriptor in the registry, runs the agent,
 * then applies programmatic + (optional) LLM judging. Used when the caller
 * doesn't inject a `runCell` in the config.
 */
export function makeRegistryRunCell(
  registry: Map<string, AgentDescriptor>,
  judgeModel?: LanguageModel,
): RunCellFn {
  return async ({ scenario, arm, model, runIndex, pool, config }) => {
    const descriptor = registry.get(arm);
    if (!descriptor) {
      throw new Error(`unknown arm "${arm}" — not in agent registry`);
    }

    const cell = await descriptor.run({
      scenario,
      pool,
      model: { id: model.id, model: model.model },
      runIndex,
      topK: config.topK,
      maxSteps: config.maxSteps,
      perRunTimeoutMs: config.perRunTimeoutMs,
      seed: config.seed,
      pricing: config.pricing,
    });

    const programmatic = judgeProgrammatic(scenario.gold_tools, cell.effective_tool_ids);
    cell.programmatic_verdict = programmatic.verdict;

    if (judgeModel && (programmatic.verdict === "n/a" || programmatic.verdict === "fail")) {
      const judged = await judgeLLM({
        prompt: scenario.prompt,
        judgeCriteria: scenario.judge_criteria,
        finalText: cell.final_text,
        model: judgeModel,
      });
      cell.judge_verdict = judged.verdict;
    }
    return cell;
  };
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
  model: RunnerModel;
  runIndex: number;
  expandedPool: ToolSpec[];
  /** Key into `cellDollarsByGroup` — accumulated cost per (scenario, model). */
  cellGroupKey: string;
}

/**
 * Materializes the full task list ahead of time so the worker pool has a flat
 * queue to consume. Pool expansion is shared across runs of the same scenario
 * (it's a pure derivation of inputs, so sharing is safe and saves repeated
 * work). Already-completed cells are filtered out here.
 *
 * Skipping logic: when a registry is available and the descriptor declares
 * `skipForModel(model.id)`, those cells are filtered out at queue-build time
 * (they don't count as "skipped due to resume" and don't write a JSONL row).
 *
 * The order is the same as the legacy nested loop (scenarios × arms × models
 * × runs); workers pick from the head of the queue, so at concurrency=1
 * behavior is byte-identical to the pre-parallel runner.
 */
function buildTaskQueue(
  scenarios: Scenario[],
  universe: ReturnType<typeof buildToolUniverse>,
  config: RunnerConfig,
  completed: Set<string>,
  registry: Map<string, AgentDescriptor> | undefined,
): { tasks: PendingTask[]; cellsSkipped: number } {
  const tasks: PendingTask[] = [];
  let cellsSkipped = 0;
  for (const scenario of scenarios) {
    const expandedPool = expandPool(scenario, universe, config.poolSize, config.seed);
    for (const arm of config.arms) {
      const descriptor = registry?.get(arm);
      for (const model of config.models) {
        if (descriptor?.skipForModel?.(model.id)) continue;
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

  // Build the registry only when the runner needs it: production runs (no
  // injected `runCell`) need it for dispatch; test runs that inject `runCell`
  // skip it entirely so they aren't coupled to the on-disk agent files.
  const registry = config.registry ?? (config.runCell ? undefined : await loadAgentRegistry());
  if (registry && !config.runCell) {
    for (const arm of config.arms) {
      if (!registry.has(arm)) {
        throw new Error(
          `arm "${arm}" not in agent registry. Known: ${[...registry.keys()].join(", ")}`,
        );
      }
    }
  }

  const { tasks, cellsSkipped: initialSkipped } = buildTaskQueue(
    scenarios,
    universe,
    config,
    completed,
    registry,
  );

  const concurrency = Math.max(1, Math.floor(config.concurrency ?? 1));
  const runCellFn = config.runCell ?? makeRegistryRunCell(registry ?? new Map(), config.judgeModel);
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
        model: task.model,
        runIndex: task.runIndex,
        pool: task.expandedPool,
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
      logCell(cell, logLevel, cellsRun, totalToRun);
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
