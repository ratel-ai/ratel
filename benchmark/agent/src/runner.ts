// Drives every (scenario, arm, model, run_index) cell, dispatching the agent
// run through the registry, judging the result, and writing one JSONL row
// per cell.
//
// Resumable: skips cells already present in the output JSONL unless `force` is
// set. A global dollar cap bounds total spend so a misconfigured catalog
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
import { type PricingTable, SDK_VERSION } from "./metering.js";
import { buildToolUniverse, expandPool } from "./pool.js";
import type { AgentDescriptor, Arm, CellResult, Scenario, ToolSpec } from "./types.js";

/**
 * Arms whose cell results don't depend on the ratel-specific code path being
 * iterated on (they expose tools directly, with no ranking/dispatch in
 * between). Re-running them per campaign is pure waste once we've measured
 * them at a given ratel version. The runner reads cached rows from a prior
 * canonical run's `agent.jsonl` and emits them into the current output without
 * paying for another live agent loop.
 */
const CACHEABLE_ARMS: ReadonlySet<Arm> = new Set(["control-baseline", "control-oracle"]);

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
  /**
   * Pool sizes to sweep over for non-agnostic arms. Each scenario is evaluated
   * at every value (cells are duplicated across pool sizes), so a 50-scenario ×
   * 4-pool sweep produces 200 cells per (sweep arm, model, run). Pool-size-
   * agnostic arms (e.g. `control-oracle`) ignore this list and emit one cell
   * per (scenario, model, run). Always non-empty; the CLI defaults to `[180]`
   * when neither `--pool-size` nor `--pool-sizes` is passed.
   */
  poolSizes: number[];
  maxSteps: number;
  perRunTimeoutMs: number;
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
   * The global dollar cap is best-effort under concurrency: when it fires,
   * in-flight cells finish but no new ones start, so overshoot is bounded by
   * `concurrency × per-cell cost`.
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
  /**
   * `@ratel-ai/sdk` version this campaign is measuring. Embedded in every
   * row's `ratel_version` field and used as a cache-key dimension so a row
   * written under v0.1.4 never satisfies a v0.1.5 request. Defaults to the
   * resolved SDK version at module-load time; tests override.
   */
  ratelVersion?: string;
  /**
   * Persistent canonical `agent.jsonl` to consult for cached control-arm
   * rows. When set and different from `outputPath`, the runner reads
   * cacheable-arm rows whose `ratel_version` matches and emits them into
   * `outputPath` without re-running the cell. Ephemeral runs set this to the
   * canonical file so iteration on ratel arms doesn't re-pay for controls.
   * `force: true` disables the cache.
   */
  cacheSourcePath?: string;
}

export type RunCellFn = (args: {
  scenario: Scenario;
  arm: Arm;
  model: RunnerModel;
  runIndex: number;
  pool: ToolSpec[];
  /**
   * Value to write into the row. `null` for pool-size-agnostic arms (whose
   * `pool` is empty and whose row is one-per-scenario regardless of `--pool-sizes`).
   */
  poolSize: number | null;
  config: RunnerConfig;
}) => Promise<CellResult>;

export interface RunnerSummary {
  cells_run: number;
  cells_skipped: number;
  /** Cells served from `cacheSourcePath` (control arms, matching ratel_version) instead of running live. */
  cells_cached: number;
  scenarios: number;
  total_dollars: number;
  stopped_reason: "completed" | "global_cap";
}

interface CellKey {
  ratelVersion: string;
  scenarioId: string;
  arm: Arm;
  model: string;
  runIndex: number;
  /** `null` for pool-size-agnostic arms — drops the `::p<n>` suffix from the key. */
  poolSize: number | null;
}

function cellKeyString(k: CellKey): string {
  const base = `${k.ratelVersion}::${k.scenarioId}::${k.arm}::${k.model}::${k.runIndex}`;
  return k.poolSize === null ? base : `${base}::p${k.poolSize}`;
}

function cellKeyOf(cell: CellResult): string {
  return cellKeyString({
    ratelVersion: cell.ratel_version,
    scenarioId: cell.scenario_id,
    arm: cell.arm,
    model: cell.model,
    runIndex: cell.run_index,
    poolSize: cell.pool_size,
  });
}

function readCompletedKeys(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const out = new Set<string>();
  const text = readFileSync(path, "utf-8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const cell = JSON.parse(line) as CellResult;
      // Pre-`ratel_version` rows have undefined here and never match a current
      // task's key — they're effectively ignored, which is the right behavior
      // (we don't know what code shape produced them).
      if (typeof cell.ratel_version !== "string") continue;
      out.add(cellKeyOf(cell));
    } catch {
      // Ignore malformed rows; resumability is best-effort.
    }
  }
  return out;
}

/**
 * Build a cache index from a canonical `agent.jsonl` for control-arm rows
 * matching `ratelVersion`. Used by ephemeral runs to skip re-running controls
 * (which don't depend on the ratel code path being iterated on).
 */
function readControlCacheIndex(path: string, ratelVersion: string): Map<string, CellResult> {
  if (!existsSync(path)) return new Map();
  const out = new Map<string, CellResult>();
  const text = readFileSync(path, "utf-8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const cell = JSON.parse(line) as CellResult;
      if (typeof cell.ratel_version !== "string") continue;
      if (cell.ratel_version !== ratelVersion) continue;
      if (!CACHEABLE_ARMS.has(cell.arm)) continue;
      out.set(cellKeyOf(cell), cell);
    } catch {
      // Ignore malformed rows.
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
  return async ({ scenario, arm, model, runIndex, pool, poolSize, config }) => {
    const descriptor = registry.get(arm);
    if (!descriptor) {
      throw new Error(`unknown arm "${arm}" — not in agent registry`);
    }

    const cell = await descriptor.run({
      scenario,
      pool,
      poolSize,
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
      cell.judge_explanation = judged.explanation;
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
  /** Pool passed to the agent. Empty for pool-size-agnostic arms. */
  expandedPool: ToolSpec[];
  /** Value written to `CellResult.pool_size`. `null` for pool-size-agnostic arms. */
  poolSize: number | null;
  /** Pre-computed cell key (used for cache lookup before dispatching the live worker). */
  key: string;
}

/**
 * Materializes the full task list ahead of time so the worker pool has a flat
 * queue to consume. Pool expansion is shared across the multiple visits to
 * the same (scenario, pool_size) pair (one per run × arm × model) via a
 * memoized cache. Already-completed cells are filtered out here.
 *
 * Skipping logic: when a registry is available and the descriptor declares
 * `skipForModel(model.id)`, those cells are filtered out at queue-build time
 * (they don't count as "skipped due to resume" and don't write a JSONL row).
 *
 * Pool-size-agnostic arms (e.g. `control-oracle`) skip the `--pool-sizes` loop
 * entirely: each is emitted exactly once per (scenario, model, run) with an
 * empty `expandedPool` and `poolSize: null`. Their result depends only on the
 * scenario, so multiplying them by pool size would burn API spend on duplicate
 * runs and clutter the report with fake pool labels.
 *
 * Iteration order (runs × scenarios × [agnostic arms once] × pool_sizes × non-
 * agnostic arms × models): runs are outermost so a partial budget completes one
 * full pass before starting the next; agnostic arms come first within a
 * scenario so they ship even under tight budgets. Workers pick from the head
 * of the queue, so at concurrency=1 JSONL order is deterministic.
 */
function buildTaskQueue(
  scenarios: Scenario[],
  universe: ReturnType<typeof buildToolUniverse>,
  config: RunnerConfig,
  ratelVersion: string,
  completed: Set<string>,
  registry: Map<string, AgentDescriptor> | undefined,
): { tasks: PendingTask[]; cellsSkipped: number } {
  const poolCache = new Map<string, ToolSpec[]>();
  const expand = (scenario: Scenario, poolSize: number): ToolSpec[] => {
    const key = `${scenario.id}::${poolSize}`;
    let pool = poolCache.get(key);
    if (!pool) {
      pool = expandPool(scenario, universe, poolSize, config.seed);
      poolCache.set(key, pool);
    }
    return pool;
  };

  const isAgnostic = (arm: Arm): boolean => registry?.get(arm)?.poolSizeAgnostic === true;
  const agnosticArms = config.arms.filter(isAgnostic);
  const sweepArms = config.arms.filter((arm) => !isAgnostic(arm));

  const tasks: PendingTask[] = [];
  let cellsSkipped = 0;
  const tryEnqueue = (
    scenario: Scenario,
    arm: Arm,
    model: RunnerModel,
    runIndex: number,
    expandedPool: ToolSpec[],
    poolSize: number | null,
  ): void => {
    const descriptor = registry?.get(arm);
    if (descriptor?.skipForModel?.(model.id)) return;
    const key = cellKeyString({
      ratelVersion,
      scenarioId: scenario.id,
      arm,
      model: model.id,
      runIndex,
      poolSize,
    });
    if (completed.has(key)) {
      cellsSkipped++;
      return;
    }
    tasks.push({ scenario, arm, model, runIndex, expandedPool, poolSize, key });
  };

  for (let runIndex = 0; runIndex < config.runsPerCell; runIndex++) {
    for (const scenario of scenarios) {
      // Agnostic arms first: one cell each per (scenario, model, run), no pool dim.
      for (const arm of agnosticArms) {
        for (const model of config.models) {
          tryEnqueue(scenario, arm, model, runIndex, [], null);
        }
      }
      for (const poolSize of config.poolSizes) {
        const expandedPool = expand(scenario, poolSize);
        for (const arm of sweepArms) {
          for (const model of config.models) {
            tryEnqueue(scenario, arm, model, runIndex, expandedPool, expandedPool.length);
          }
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

  const ratelVersion = config.ratelVersion ?? SDK_VERSION;
  // Cache only applies when an external source is provided AND it isn't this
  // run's output (which is already covered by the resume `completed` set).
  // `--force` disables it.
  const cacheIndex =
    !config.force && config.cacheSourcePath && config.cacheSourcePath !== config.outputPath
      ? readControlCacheIndex(config.cacheSourcePath, ratelVersion)
      : new Map<string, CellResult>();

  const { tasks, cellsSkipped: initialSkipped } = buildTaskQueue(
    scenarios,
    universe,
    config,
    ratelVersion,
    completed,
    registry,
  );

  // Drain cache hits up front so the worker pool only deals with live cells.
  // Hits are appended in task-iteration order so JSONL ordering matches a fresh
  // live run at the same args.
  let cellsCached = 0;
  const liveTasks: PendingTask[] = [];
  for (const task of tasks) {
    const cached = cacheIndex.get(task.key);
    if (cached) {
      appendRow(config.outputPath, cached);
      cellsCached++;
    } else {
      liveTasks.push(task);
    }
  }

  if ((config.logLevel ?? "normal") !== "quiet" && (cellsCached > 0 || cacheIndex.size > 0)) {
    console.error(
      `cache: ${cellsCached} control cells reused from ${config.cacheSourcePath} ` +
        `(ratel ${ratelVersion}), ${liveTasks.length} will run`,
    );
  }

  const concurrency = Math.max(1, Math.floor(config.concurrency ?? 1));
  const runCellFn = config.runCell ?? makeRegistryRunCell(registry ?? new Map(), config.judgeModel);
  const logLevel = config.logLevel ?? "normal";

  let cellsRun = 0;
  let totalDollars = 0;
  let stopped: RunnerSummary["stopped_reason"] = "completed";
  let nextTaskIdx = 0;

  // Pick the next runnable task, or `null` if the queue is drained / the
  // global dollar cap has fired. Synchronous; safe to call from any worker
  // because the JS event loop guarantees no preemption between the read and
  // the increment.
  const pickTask = (): PendingTask | null => {
    if (stopped !== "completed") return null;
    if (totalDollars >= config.dollarGlobalCap) {
      stopped = "global_cap";
      return null;
    }
    if (nextTaskIdx >= liveTasks.length) return null;
    return liveTasks[nextTaskIdx++];
  };

  const totalToRun = liveTasks.length;
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
        poolSize: task.poolSize,
        config,
      });
      // Synchronous tail: append + counters happen without yielding, so two
      // workers cannot interleave their writes or accumulator updates.
      appendRow(config.outputPath, cell);
      cellsRun++;
      totalDollars += cell.dollar_cost;
      logCell(cell, logLevel, cellsRun, totalToRun);
      if (totalDollars >= config.dollarGlobalCap) {
        stopped = "global_cap";
      }
    }
  };

  const workerCount = Math.min(concurrency, Math.max(1, liveTasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return {
    cells_run: cellsRun,
    cells_skipped: initialSkipped,
    cells_cached: cellsCached,
    scenarios: scenarios.length,
    total_dollars: totalDollars,
    stopped_reason: stopped,
  };
}
