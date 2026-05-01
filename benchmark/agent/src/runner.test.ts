import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunCellFn, type RunnerConfig, run } from "./runner.js";
import type { CellResult, Scenario } from "./types.js";

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
  gold_trace: [
    { tool_id: "fs.read_file", args: { path: "/etc/hosts" }, response: { contents: "ok" } },
  ],
};

function makeFakeRunCell(perCellDollars: number, called: string[]): RunCellFn {
  return async ({ scenario: s, arm, model, runIndex }) => {
    const key = `${s.id}::${arm}::${model.id}::${runIndex}`;
    called.push(key);
    const cell: CellResult = {
      scenario_id: s.id,
      arm,
      model: model.id,
      run_index: runIndex,
      catalog_size: 1,
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
    arms: ["control", "hybrid", "oracle"],
    models: [{ id: "fake-model", model: {} as never }],
    runsPerCell: 1,
    topK: 3,
    maxSteps: 8,
    perRunTimeoutMs: 1000,
    dollarCellCap: 1.0,
    dollarGlobalCap: 100.0,
    force: false,
    seed: 42,
    logLevel: "quiet",
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
      "fs-001::control::fake-model::0",
      "fs-001::hybrid::fake-model::0",
      "fs-001::oracle::fake-model::0",
    ]);
    const lines = readFileSync(output, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);
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

  it("stops at the global dollar cap", async () => {
    const corpus = join(tempDir, "corpus.jsonl");
    const s2 = { ...scenario, id: "fs-002" };
    const s3 = { ...scenario, id: "fs-003" };
    writeFileSync(corpus, [scenario, s2, s3].map((s) => JSON.stringify(s)).join("\n"));
    const output = join(tempDir, "agent.jsonl");
    const called: string[] = [];
    const summary = await run({
      ...baseConfig(corpus, output),
      arms: ["control"],
      dollarGlobalCap: 0.0015, // budget for ~1.5 cells at $0.001 each — third should bail
      runCell: makeFakeRunCell(0.001, called),
    });
    expect(summary.stopped_reason).toBe("global_cap");
    expect(summary.cells_run).toBeLessThan(3);
  });
});
