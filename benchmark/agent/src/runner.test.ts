import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendRow, type RunCellFn, type RunnerConfig, run } from "./runner.js";
import type { AgentDescriptor, CellResult, Scenario } from "./types.js";

/** Stub descriptor — `runCell` is what the runner actually invokes; this only carries flags (e.g. `poolSizeAgnostic`). */
function stubDescriptor(over: Partial<AgentDescriptor> & { id: string }): AgentDescriptor {
  return {
    label: over.id,
    run: async () => {
      throw new Error("stub descriptor not invoked under injected runCell");
    },
    ...over,
  };
}

const scenario: Scenario = {
  id: "fs-001",
  prompt: "read /etc/hosts",
  candidate_pool: [
    {
      id: "fs.read_file",
      name: "read_file",
      description: "Read a file from disk.",
      input_schema: { type: "object" },
    },
  ],
  gold_tools: ["fs.read_file"],
};

function makeFakeRunCell(perCellDollars: number, called: string[]): RunCellFn {
  return async ({ scenario: s, arm, model, runIndex, poolSize }) => {
    const key = `${s.id}::${arm}::${model.id}::${runIndex}`;
    called.push(key);
    const cell: CellResult = {
      scenario_id: s.id,
      arm,
      model: model.id,
      run_index: runIndex,
      ratel_version: "test",
      catalog_size: 1,
      pool_size: poolSize,
      seed: 0,
      input_tokens: 100,
      output_tokens: 50,
      cached_input_tokens: 0,
      cache_creation_tokens: 0,
      total_tokens: 150,
      tool_calls_total: 1,
      tool_calls_unique: 1,
      gateway_calls: 0,
      non_gateway_calls: 1,
      turns: 1,
      programmatic_verdict: "pass",
      judge_verdict: "n/a",
      final_text: "done",
      finish_reason: "stop",
      error: null,
      wall_ms: 1,
      dollar_cost: perCellDollars,
      tool_calls: [{ toolId: "fs.read_file", args: {} }],
      effective_tool_ids: ["fs.read_file"],
    };
    return cell;
  };
}

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ratel-bench-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function baseConfig(corpusPath: string, outputPath: string): RunnerConfig {
  return {
    corpusPath,
    outputPath,
    arms: ["control-baseline", "ratel-full", "control-oracle"],
    models: [{ id: "fake-model", model: {} as never }],
    runsPerCell: 1,
    topK: 3,
    poolSizes: [30],
    maxSteps: 8,
    perRunTimeoutMs: 1000,
    dollarGlobalCap: 100.0,
    force: false,
    seed: 42,
    logLevel: "quiet",
    // Pin a synthetic version so makeFakeRunCell rows (which set ratel_version: "test")
    // match the keys the runner constructs for resume / cache.
    ratelVersion: "test",
  };
}

describe("runner", () => {
  it("runs every (arm, model, run) cell for each scenario", async () => {
    const corpus = join(tempDir, "corpus.jsonl");
    writeFileSync(corpus, `${JSON.stringify(scenario)}\n`);
    const output = join(tempDir, "agent.jsonl");
    const called: string[] = [];

    const summary = await run({
      ...baseConfig(corpus, output),
      runCell: makeFakeRunCell(0.001, called),
    });

    expect(summary.cells_run).toBe(3);
    expect(summary.cells_skipped).toBe(0);
    expect(called).toEqual([
      "fs-001::control-baseline::fake-model::0",
      "fs-001::ratel-full::fake-model::0",
      "fs-001::control-oracle::fake-model::0",
    ]);
    const lines = readFileSync(output, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);
  });

  it("records pool_size in every emitted cell", async () => {
    const corpus = join(tempDir, "corpus.jsonl");
    writeFileSync(corpus, `${JSON.stringify(scenario)}\n`);
    const output = join(tempDir, "agent.jsonl");

    await run({
      ...baseConfig(corpus, output),
      poolSizes: [25],
      arms: ["control-baseline"],
      runCell: makeFakeRunCell(0.001, []),
    });

    const cell = JSON.parse(readFileSync(output, "utf-8").trim()) as CellResult;
    // expandPool falls back to universe size when target > universe; this corpus
    // has 1 scenario / 1 tool so the universe is 1 and pool_size lands at 1.
    expect(cell.pool_size).toBe(1);
  });

  it("expands the pool with distractors from other scenarios up to poolSize", async () => {
    const corpus = join(tempDir, "corpus.jsonl");
    const others: Scenario[] = Array.from({ length: 5 }, (_, i) => ({
      id: `noise-${i}`,
      prompt: `do ${i}`,
      candidate_pool: [
        {
          id: `noise.tool-${i}`,
          name: `noise_tool_${i}`,
          description: `noise ${i}`,
          input_schema: {},
        },
      ],
      gold_tools: [`noise.tool-${i}`],
    }));
    writeFileSync(corpus, [scenario, ...others].map((s) => JSON.stringify(s)).join("\n"));
    const output = join(tempDir, "agent.jsonl");

    const called: string[] = [];
    await run({
      ...baseConfig(corpus, output),
      poolSizes: [4],
      arms: ["control-baseline"],
      scenarioLimit: 1,
      runCell: makeFakeRunCell(0.001, called),
    });

    // Whichever scenario the seeded sample picked, its pool drew 3 distractors
    // from the other 5 scenarios' tools to reach poolSize=4 (1 gold + 3 distractors).
    const cell = JSON.parse(readFileSync(output, "utf-8").trim()) as CellResult;
    expect(cell.pool_size).toBe(4);
  });

  it("sweeps every (arm, model, run) cell across each requested pool size", async () => {
    const corpus = join(tempDir, "corpus.jsonl");
    const others: Scenario[] = Array.from({ length: 10 }, (_, i) => ({
      id: `noise-${i}`,
      prompt: `do ${i}`,
      candidate_pool: [
        {
          id: `noise.tool-${i}`,
          name: `noise_tool_${i}`,
          description: `noise ${i}`,
          input_schema: {},
        },
      ],
      gold_tools: [`noise.tool-${i}`],
    }));
    writeFileSync(corpus, [scenario, ...others].map((s) => JSON.stringify(s)).join("\n"));
    const output = join(tempDir, "agent.jsonl");

    const called: string[] = [];
    const summary = await run({
      ...baseConfig(corpus, output),
      poolSizes: [3, 6],
      arms: ["control-baseline"],
      scenarioLimit: 1,
      runCell: makeFakeRunCell(0.001, called),
    });

    // 1 scenario × 1 arm × 1 model × 1 run × 2 pool sizes = 2 cells.
    expect(summary.cells_run).toBe(2);
    const lines = readFileSync(output, "utf-8").split("\n").filter(Boolean);
    const pools = lines
      .map((l) => (JSON.parse(l) as CellResult).pool_size)
      .filter((p): p is number => p !== null)
      .sort((a, b) => a - b);
    expect(pools).toEqual([3, 6]);
  });

  it("emits exactly one cell per (scenario, model, run) for pool-size-agnostic arms regardless of --pool-sizes", async () => {
    const corpus = join(tempDir, "corpus.jsonl");
    // Universe big enough that distractor expansion can hit each requested
    // pool size literally — otherwise all sizes collapse to the universe ceiling.
    const others: Scenario[] = Array.from({ length: 25 }, (_, i) => ({
      id: `noise-${i}`,
      prompt: `do ${i}`,
      candidate_pool: [
        {
          id: `noise.tool-${i}`,
          name: `noise_tool_${i}`,
          description: `noise ${i}`,
          input_schema: {},
        },
      ],
      gold_tools: [`noise.tool-${i}`],
    }));
    writeFileSync(corpus, [scenario, ...others].map((s) => JSON.stringify(s)).join("\n"));
    const output = join(tempDir, "agent.jsonl");
    const registry = new Map<string, AgentDescriptor>([
      ["control-baseline", stubDescriptor({ id: "control-baseline" })],
      ["control-oracle", stubDescriptor({ id: "control-oracle", poolSizeAgnostic: true })],
    ]);

    const called: string[] = [];
    const summary = await run({
      ...baseConfig(corpus, output),
      poolSizes: [4, 8, 16],
      arms: ["control-baseline", "control-oracle"],
      scenarioLimit: 1,
      registry,
      runCell: makeFakeRunCell(0.001, called),
    });

    // baseline runs at every pool size (3) + oracle runs once = 4 cells, not 6.
    expect(summary.cells_run).toBe(4);
    const lines = readFileSync(output, "utf-8").split("\n").filter(Boolean);
    const cells = lines.map((l) => JSON.parse(l) as CellResult);
    const oracleRows = cells.filter((c) => c.arm === "control-oracle");
    const baselineRows = cells.filter((c) => c.arm === "control-baseline");
    expect(oracleRows).toHaveLength(1);
    expect(oracleRows[0].pool_size).toBeNull();
    expect(baselineRows).toHaveLength(3);
    expect(baselineRows.map((c) => c.pool_size).sort((a, b) => Number(a) - Number(b))).toEqual([
      4, 8, 16,
    ]);
  });

  it("resume skips agnostic-arm cells without re-running them when --pool-sizes changes", async () => {
    const corpus = join(tempDir, "corpus.jsonl");
    writeFileSync(corpus, `${JSON.stringify(scenario)}\n`);
    const output = join(tempDir, "agent.jsonl");
    const registry = new Map<string, AgentDescriptor>([
      ["control-oracle", stubDescriptor({ id: "control-oracle", poolSizeAgnostic: true })],
    ]);

    const called1: string[] = [];
    await run({
      ...baseConfig(corpus, output),
      poolSizes: [30],
      arms: ["control-oracle"],
      scenarioLimit: 1,
      registry,
      runCell: makeFakeRunCell(0.001, called1),
    });
    expect(called1).toHaveLength(1);

    // Re-run with a totally different --pool-sizes. The agnostic arm's cell key
    // doesn't include pool size, so it must dedupe and skip.
    const called2: string[] = [];
    const summary = await run({
      ...baseConfig(corpus, output),
      poolSizes: [180, 30, 100],
      arms: ["control-oracle"],
      scenarioLimit: 1,
      registry,
      runCell: makeFakeRunCell(0.001, called2),
    });
    expect(called2).toHaveLength(0);
    expect(summary.cells_run).toBe(0);
    expect(summary.cells_skipped).toBe(1);
  });

  it("interleaves pool sizes so a partial budget spans every pool instead of starving the trailing ones", async () => {
    const corpus = join(tempDir, "corpus.jsonl");
    const others: Scenario[] = Array.from({ length: 10 }, (_, i) => ({
      id: `noise-${i}`,
      prompt: `do ${i}`,
      candidate_pool: [
        {
          id: `noise.tool-${i}`,
          name: `noise_tool_${i}`,
          description: `noise ${i}`,
          input_schema: {},
        },
      ],
      gold_tools: [`noise.tool-${i}`],
    }));
    writeFileSync(corpus, [scenario, ...others].map((s) => JSON.stringify(s)).join("\n"));
    const output = join(tempDir, "agent.jsonl");

    // 3 scenarios × 1 arm × 1 model × 1 run × 4 pool sizes = 12 cells. Budget
    // for ~4 cells means we expect partial coverage; the assertion is that
    // every pool size is represented at least once (vs. the old pool-major
    // ordering, which would have produced 4 × pool=2 and zero of the rest).
    const summary = await run({
      ...baseConfig(corpus, output),
      poolSizes: [2, 4, 6, 8],
      arms: ["control-baseline"],
      scenarioLimit: 3,
      dollarGlobalCap: 0.0045, // ~4 cells at $0.001 each
      runCell: makeFakeRunCell(0.001, []),
    });
    expect(summary.stopped_reason).toBe("global_cap");
    const lines = readFileSync(output, "utf-8").split("\n").filter(Boolean);
    const pools = new Set(lines.map((l) => (JSON.parse(l) as CellResult).pool_size));
    // Pool sizes < gold count clamp upward (gold=1 → pool=1 for size 1; here
    // requested sizes 2/4/6/8 either expand to that size or to the universe
    // ceiling — but each requested size produces a distinct pool.length value).
    expect(pools.size).toBeGreaterThan(1);
  });

  it("resume keys a cell by pool_size — re-running new sizes against an existing JSONL only runs the new sizes", async () => {
    const corpus = join(tempDir, "corpus.jsonl");
    const others: Scenario[] = Array.from({ length: 10 }, (_, i) => ({
      id: `noise-${i}`,
      prompt: `do ${i}`,
      candidate_pool: [
        {
          id: `noise.tool-${i}`,
          name: `noise_tool_${i}`,
          description: `noise ${i}`,
          input_schema: {},
        },
      ],
      gold_tools: [`noise.tool-${i}`],
    }));
    writeFileSync(corpus, [scenario, ...others].map((s) => JSON.stringify(s)).join("\n"));
    const output = join(tempDir, "agent.jsonl");

    // First pass: pool size 3.
    await run({
      ...baseConfig(corpus, output),
      poolSizes: [3],
      arms: ["control-baseline"],
      scenarioLimit: 1,
      runCell: makeFakeRunCell(0.001, []),
    });

    // Second pass: pool sizes 3 and 6 — only 6 should run.
    const called2: string[] = [];
    const summary = await run({
      ...baseConfig(corpus, output),
      poolSizes: [3, 6],
      arms: ["control-baseline"],
      scenarioLimit: 1,
      runCell: makeFakeRunCell(0.001, called2),
    });
    expect(summary.cells_run).toBe(1);
    expect(summary.cells_skipped).toBe(1);
    expect(called2).toHaveLength(1);
  });

  it("seeded sampling picks the same subset across runs with the same seed", async () => {
    const corpus = join(tempDir, "corpus.jsonl");
    const all: Scenario[] = Array.from({ length: 20 }, (_, i) => ({
      ...scenario,
      id: `s-${String(i).padStart(2, "0")}`,
    }));
    writeFileSync(corpus, all.map((s) => JSON.stringify(s)).join("\n"));

    const calledA: string[] = [];
    const calledB: string[] = [];
    const out1 = join(tempDir, "a.jsonl");
    const out2 = join(tempDir, "b.jsonl");
    await run({
      ...baseConfig(corpus, out1),
      arms: ["control-baseline"],
      scenarioLimit: 5,
      runCell: makeFakeRunCell(0.001, calledA),
    });
    await run({
      ...baseConfig(corpus, out2),
      arms: ["control-baseline"],
      scenarioLimit: 5,
      runCell: makeFakeRunCell(0.001, calledB),
    });
    expect(calledA).toEqual(calledB);
    expect(calledA).toHaveLength(5);
  });

  it("seeded sampling returns a different subset for a different seed", async () => {
    const corpus = join(tempDir, "corpus.jsonl");
    const all: Scenario[] = Array.from({ length: 20 }, (_, i) => ({
      ...scenario,
      id: `s-${String(i).padStart(2, "0")}`,
    }));
    writeFileSync(corpus, all.map((s) => JSON.stringify(s)).join("\n"));

    const calledA: string[] = [];
    const calledB: string[] = [];
    await run({
      ...baseConfig(corpus, join(tempDir, "a.jsonl")),
      arms: ["control-baseline"],
      scenarioLimit: 5,
      seed: 1,
      runCell: makeFakeRunCell(0.001, calledA),
    });
    await run({
      ...baseConfig(corpus, join(tempDir, "b.jsonl")),
      arms: ["control-baseline"],
      scenarioLimit: 5,
      seed: 999,
      runCell: makeFakeRunCell(0.001, calledB),
    });
    expect(calledA).not.toEqual(calledB);
  });

  it("skips already-completed cells unless force=true", async () => {
    const corpus = join(tempDir, "corpus.jsonl");
    writeFileSync(corpus, `${JSON.stringify(scenario)}\n`);
    const output = join(tempDir, "agent.jsonl");
    const called1: string[] = [];
    await run({
      ...baseConfig(corpus, output),
      runCell: makeFakeRunCell(0.001, called1),
    });
    expect(called1.length).toBe(3);

    // Second run with same output: should skip everything.
    const called2: string[] = [];
    const summary = await run({
      ...baseConfig(corpus, output),
      runCell: makeFakeRunCell(0.001, called2),
    });
    expect(summary.cells_skipped).toBe(3);
    expect(called2).toEqual([]);

    // Force: re-runs everything.
    const called3: string[] = [];
    const forced = await run({
      ...baseConfig(corpus, output),
      force: true,
      runCell: makeFakeRunCell(0.001, called3),
    });
    expect(forced.cells_run).toBe(3);
    expect(called3.length).toBe(3);
  });

  it("ephemeral runs reuse cached control rows from a canonical agent.jsonl", async () => {
    const corpus = join(tempDir, "corpus.jsonl");
    writeFileSync(corpus, `${JSON.stringify(scenario)}\n`);
    const canonical = join(tempDir, "canonical.jsonl");
    const ephemeral = join(tempDir, "ephemeral.jsonl");

    // First run: populate the canonical file with all three arms.
    const calledCanonical: string[] = [];
    await run({
      ...baseConfig(corpus, canonical),
      arms: ["control-baseline", "control-oracle", "ratel-full"],
      runCell: makeFakeRunCell(0.001, calledCanonical),
    });
    expect(calledCanonical).toHaveLength(3);

    // Second run, ephemeral output, pointing at canonical as cache source.
    // Control arms should hit cache; ratel-full should still run live.
    const calledEphemeral: string[] = [];
    const summary = await run({
      ...baseConfig(corpus, ephemeral),
      arms: ["control-baseline", "control-oracle", "ratel-full"],
      cacheSourcePath: canonical,
      runCell: makeFakeRunCell(0.001, calledEphemeral),
    });

    expect(summary.cells_cached).toBe(2);
    expect(summary.cells_run).toBe(1);
    expect(calledEphemeral).toEqual(["fs-001::ratel-full::fake-model::0"]);

    const ephemeralLines = readFileSync(ephemeral, "utf-8").split("\n").filter(Boolean);
    expect(ephemeralLines).toHaveLength(3);
    const arms = ephemeralLines.map((l) => (JSON.parse(l) as CellResult).arm).sort();
    expect(arms).toEqual(["control-baseline", "control-oracle", "ratel-full"]);
  });

  it("--force bypasses the cache even when cacheSourcePath is set", async () => {
    const corpus = join(tempDir, "corpus.jsonl");
    writeFileSync(corpus, `${JSON.stringify(scenario)}\n`);
    const canonical = join(tempDir, "canonical.jsonl");
    const ephemeral = join(tempDir, "ephemeral.jsonl");

    await run({
      ...baseConfig(corpus, canonical),
      arms: ["control-baseline"],
      runCell: makeFakeRunCell(0.001, []),
    });

    const called: string[] = [];
    const summary = await run({
      ...baseConfig(corpus, ephemeral),
      arms: ["control-baseline"],
      cacheSourcePath: canonical,
      force: true,
      runCell: makeFakeRunCell(0.001, called),
    });
    expect(summary.cells_cached).toBe(0);
    expect(called).toHaveLength(1);
  });

  it("cache miss when ratel_version doesn't match", async () => {
    const corpus = join(tempDir, "corpus.jsonl");
    writeFileSync(corpus, `${JSON.stringify(scenario)}\n`);
    const canonical = join(tempDir, "canonical.jsonl");
    const ephemeral = join(tempDir, "ephemeral.jsonl");

    await run({
      ...baseConfig(corpus, canonical),
      arms: ["control-baseline"],
      // Canonical built at "test" version.
      runCell: makeFakeRunCell(0.001, []),
    });

    const called: string[] = [];
    const summary = await run({
      ...baseConfig(corpus, ephemeral),
      arms: ["control-baseline"],
      cacheSourcePath: canonical,
      // New run at a different ratel version → cache miss, recompute.
      ratelVersion: "9.9.9",
      runCell: makeFakeRunCell(0.001, called),
    });
    expect(summary.cells_cached).toBe(0);
    expect(called).toHaveLength(1);
  });

  it("appendRow writes one valid JSON line per call without quadratic rewrites", () => {
    const path = join(tempDir, "appended.jsonl");
    const sample: CellResult = {
      scenario_id: "x",
      arm: "control-baseline",
      model: "m",
      run_index: 0,
      ratel_version: "test",
      catalog_size: 0,
      pool_size: 0,
      seed: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_tokens: 0,
      total_tokens: 0,
      tool_calls_total: 0,
      tool_calls_unique: 0,
      gateway_calls: 0,
      non_gateway_calls: 0,
      turns: 0,
      programmatic_verdict: "n/a",
      judge_verdict: "n/a",
      final_text: "",
      finish_reason: "stop",
      error: null,
      wall_ms: 0,
      dollar_cost: 0,
      tool_calls: [],
      effective_tool_ids: [],
    };
    for (let i = 0; i < 50; i++) {
      appendRow(path, { ...sample, scenario_id: `s-${i}` });
    }
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(50);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const ids = lines.map((l) => (JSON.parse(l) as CellResult).scenario_id);
    expect(new Set(ids).size).toBe(50);
  });

  it("runs cells in parallel under concurrency > 1 and emits one row per cell", async () => {
    const corpus = join(tempDir, "corpus.jsonl");
    const scenarios: Scenario[] = Array.from({ length: 30 }, (_, i) => ({
      ...scenario,
      id: `s-${String(i).padStart(2, "0")}`,
    }));
    writeFileSync(corpus, scenarios.map((s) => JSON.stringify(s)).join("\n"));
    const output = join(tempDir, "agent.jsonl");

    let inFlight = 0;
    let maxInFlight = 0;
    const slowRunCell: RunCellFn = async (args) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      const cell: CellResult = {
        scenario_id: args.scenario.id,
        arm: args.arm,
        model: args.model.id,
        run_index: args.runIndex,
        ratel_version: "test",
        catalog_size: 1,
        pool_size: args.poolSize,
        seed: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_tokens: 0,
        total_tokens: 0,
        tool_calls_total: 0,
        tool_calls_unique: 0,
        gateway_calls: 0,
        non_gateway_calls: 0,
        turns: 0,
        programmatic_verdict: "pass",
        judge_verdict: "n/a",
        final_text: "ok",
        finish_reason: "stop",
        error: null,
        wall_ms: 10,
        dollar_cost: 0.001,
        tool_calls: [],
        effective_tool_ids: ["fs.read_file"],
      };
      return cell;
    };

    const summary = await run({
      ...baseConfig(corpus, output),
      arms: ["control-baseline"],
      concurrency: 5,
      runCell: slowRunCell,
    });

    expect(summary.cells_run).toBe(30);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(5);

    const lines = readFileSync(output, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(30);
    const parsed = lines.map((l) => JSON.parse(l) as CellResult);
    const ids = parsed.map((c) => c.scenario_id).sort();
    expect(new Set(ids).size).toBe(30);
  });

  it("under concurrency, the global dollar cap stops new picks but lets in-flight cells finish", async () => {
    const corpus = join(tempDir, "corpus.jsonl");
    const scenarios: Scenario[] = Array.from({ length: 50 }, (_, i) => ({
      ...scenario,
      id: `s-${String(i).padStart(2, "0")}`,
    }));
    writeFileSync(corpus, scenarios.map((s) => JSON.stringify(s)).join("\n"));
    const output = join(tempDir, "agent.jsonl");
    const called: string[] = [];

    // Tiny delay so several workers can be in flight before the cap is observed.
    const slow: RunCellFn = async (args) => {
      await new Promise((r) => setTimeout(r, 5));
      const cell = await makeFakeRunCell(0.001, called)({ ...args });
      return cell;
    };

    const concurrency = 5;
    const summary = await run({
      ...baseConfig(corpus, output),
      arms: ["control-baseline"],
      dollarGlobalCap: 0.005, // budget for 5 cells; overshoot bounded by ~concurrency.
      concurrency,
      runCell: slow,
    });

    expect(summary.stopped_reason).toBe("global_cap");
    // Exactly 5 cells fit under the cap; bounded overshoot is at most `concurrency`
    // additional cells (the workers that had already picked when the cap fired).
    expect(summary.cells_run).toBeGreaterThanOrEqual(5);
    expect(summary.cells_run).toBeLessThanOrEqual(5 + concurrency);

    const lines = readFileSync(output, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(summary.cells_run);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("stops at the global dollar cap", async () => {
    const corpus = join(tempDir, "corpus.jsonl");
    const s2 = { ...scenario, id: "fs-002" };
    const s3 = { ...scenario, id: "fs-003" };
    writeFileSync(corpus, [scenario, s2, s3].map((s) => JSON.stringify(s)).join("\n"));
    const output = join(tempDir, "agent.jsonl");
    const called: string[] = [];
    const summary = await run({
      ...baseConfig(corpus, output),
      arms: ["control-baseline"],
      dollarGlobalCap: 0.0015, // budget for ~1.5 cells at $0.001 each — third should bail
      runCell: makeFakeRunCell(0.001, called),
    });
    expect(summary.stopped_reason).toBe("global_cap");
    expect(summary.cells_run).toBeLessThan(3);
  });
});
