import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rejudge } from "./rejudge.js";
import type { CellResult, Scenario } from "./types.js";

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ratel-rejudge-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function scenario(over: Partial<Scenario> & { id: string }): Scenario {
  return {
    id: over.id,
    prompt: over.prompt ?? "do the thing",
    candidate_pool: over.candidate_pool ?? [],
    gold_tools: over.gold_tools ?? ["TheTool"],
    judge_criteria: over.judge_criteria,
    category: over.category,
  };
}

function cell(over: Partial<CellResult> & { scenario_id: string }): CellResult {
  return {
    scenario_id: over.scenario_id,
    arm: over.arm ?? "control-baseline",
    model: over.model ?? "fake-model",
    run_index: over.run_index ?? 0,
    ratel_version: over.ratel_version ?? "test",
    catalog_size: over.catalog_size ?? 5,
    pool_size: over.pool_size ?? 5,
    seed: over.seed ?? 0,
    input_tokens: over.input_tokens ?? 0,
    output_tokens: over.output_tokens ?? 0,
    cached_input_tokens: 0,
    cache_creation_tokens: 0,
    total_tokens: 0,
    tool_calls_total: over.tool_calls_total ?? 0,
    tool_calls_unique: 0,
    gateway_calls: 0,
    non_gateway_calls: 0,
    turns: 1,
    effective_tool_ids: over.effective_tool_ids ?? [],
    programmatic_verdict: over.programmatic_verdict ?? "fail",
    judge_verdict: over.judge_verdict ?? "n/a",
    judge_explanation: over.judge_explanation,
    final_text: over.final_text ?? "",
    finish_reason: "stop",
    error: null,
    wall_ms: 0,
    dollar_cost: 0,
    tool_calls: [],
  };
}

function writeJsonl<T>(path: string, rows: T[]): void {
  writeFileSync(path, rows.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf-8");
}

describe("rejudge", () => {
  it("re-judges programmatic-fail rows and persists the explanation", async () => {
    const inputPath = join(tempDir, "in.jsonl");
    const outputPath = join(tempDir, "out.jsonl");
    const corpusPath = join(tempDir, "corpus.jsonl");
    writeJsonl(corpusPath, [scenario({ id: "s1", prompt: "list X" })]);
    writeJsonl(inputPath, [
      cell({
        scenario_id: "s1",
        programmatic_verdict: "fail",
        judge_verdict: "pass",
        final_text: "I can't but try X",
      }),
    ]);

    const judge = vi.fn().mockResolvedValue({ verdict: "fail", explanation: "polite refusal" });
    const summary = await rejudge({
      inputPath,
      outputPath,
      corpusPath,
      // biome-ignore lint/suspicious/noExplicitAny: judge is mocked
      judgeModel: {} as any,
      judge,
    });

    expect(summary).toEqual({ total: 1, rejudged: 1, skipped_pass: 0, written: 1 });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0][0]).toMatchObject({
      prompt: "list X",
      finalText: "I can't but try X",
      promptVariant: "strict",
    });
    const out = readFileSync(outputPath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as CellResult);
    expect(out).toHaveLength(1);
    expect(out[0].judge_verdict).toBe("fail");
    expect(out[0].judge_explanation).toBe("polite refusal");
  });

  it("passes programmatic-pass rows through untouched", async () => {
    const inputPath = join(tempDir, "in.jsonl");
    const outputPath = join(tempDir, "out.jsonl");
    const corpusPath = join(tempDir, "corpus.jsonl");
    writeJsonl(corpusPath, [scenario({ id: "s1" })]);
    const original = cell({
      scenario_id: "s1",
      programmatic_verdict: "pass",
      judge_verdict: "n/a",
      effective_tool_ids: ["TheTool"],
    });
    writeJsonl(inputPath, [original]);

    const judge = vi.fn();
    const summary = await rejudge({
      inputPath,
      outputPath,
      corpusPath,
      // biome-ignore lint/suspicious/noExplicitAny: judge is mocked
      judgeModel: {} as any,
      judge,
    });

    expect(summary).toEqual({ total: 1, rejudged: 0, skipped_pass: 1, written: 1 });
    expect(judge).not.toHaveBeenCalled();
    const out = JSON.parse(readFileSync(outputPath, "utf-8").trim()) as CellResult;
    expect(out).toEqual(original);
  });

  it("re-judges programmatic-n/a rows (no gold_tools case)", async () => {
    const inputPath = join(tempDir, "in.jsonl");
    const outputPath = join(tempDir, "out.jsonl");
    const corpusPath = join(tempDir, "corpus.jsonl");
    writeJsonl(corpusPath, [scenario({ id: "s1" })]);
    writeJsonl(inputPath, [
      cell({ scenario_id: "s1", programmatic_verdict: "n/a", judge_verdict: "pass" }),
    ]);

    const judge = vi.fn().mockResolvedValue({ verdict: "fail", explanation: "x" });
    const summary = await rejudge({
      inputPath,
      outputPath,
      corpusPath,
      // biome-ignore lint/suspicious/noExplicitAny: judge is mocked
      judgeModel: {} as any,
      judge,
    });

    expect(summary.rejudged).toBe(1);
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it("forwards promptVariant to the judge", async () => {
    const inputPath = join(tempDir, "in.jsonl");
    const outputPath = join(tempDir, "out.jsonl");
    const corpusPath = join(tempDir, "corpus.jsonl");
    writeJsonl(corpusPath, [scenario({ id: "s1" })]);
    writeJsonl(inputPath, [cell({ scenario_id: "s1", programmatic_verdict: "fail" })]);

    const judge = vi.fn().mockResolvedValue({ verdict: "fail", explanation: "x" });
    await rejudge({
      inputPath,
      outputPath,
      corpusPath,
      // biome-ignore lint/suspicious/noExplicitAny: judge is mocked
      judgeModel: {} as any,
      promptVariant: "strict",
      judge,
    });

    expect(judge.mock.calls[0][0].promptVariant).toBe("strict");
  });

  it("throws when a row's scenario_id is missing from the corpus", async () => {
    const inputPath = join(tempDir, "in.jsonl");
    const outputPath = join(tempDir, "out.jsonl");
    const corpusPath = join(tempDir, "corpus.jsonl");
    writeJsonl(corpusPath, [scenario({ id: "s1" })]);
    writeJsonl(inputPath, [cell({ scenario_id: "ghost", programmatic_verdict: "fail" })]);

    const judge = vi.fn().mockResolvedValue({ verdict: "fail", explanation: "x" });
    await expect(
      rejudge({
        inputPath,
        outputPath,
        corpusPath,
        // biome-ignore lint/suspicious/noExplicitAny: judge is mocked
        judgeModel: {} as any,
        judge,
      }),
    ).rejects.toThrow(/scenario.*ghost/);
  });

  it("preserves all non-judge fields on re-judged rows", async () => {
    const inputPath = join(tempDir, "in.jsonl");
    const outputPath = join(tempDir, "out.jsonl");
    const corpusPath = join(tempDir, "corpus.jsonl");
    writeJsonl(corpusPath, [scenario({ id: "s1", prompt: "p" })]);
    const original = cell({
      scenario_id: "s1",
      programmatic_verdict: "fail",
      judge_verdict: "pass",
      input_tokens: 1234,
      output_tokens: 56,
      tool_calls_total: 2,
      arm: "ratel-full",
      model: "ollama:qwen3.5",
    });
    writeJsonl(inputPath, [original]);

    const judge = vi.fn().mockResolvedValue({ verdict: "fail", explanation: "..." });
    await rejudge({
      inputPath,
      outputPath,
      corpusPath,
      // biome-ignore lint/suspicious/noExplicitAny: judge is mocked
      judgeModel: {} as any,
      judge,
    });

    const out = JSON.parse(readFileSync(outputPath, "utf-8").trim()) as CellResult;
    // Only judge fields should change.
    expect(out).toMatchObject({
      ...original,
      judge_verdict: "fail",
      judge_explanation: "...",
    });
  });

  it("handles a mix of pass / fail / n/a rows in one file", async () => {
    const inputPath = join(tempDir, "in.jsonl");
    const outputPath = join(tempDir, "out.jsonl");
    const corpusPath = join(tempDir, "corpus.jsonl");
    writeJsonl(corpusPath, [
      scenario({ id: "s1" }),
      scenario({ id: "s2" }),
      scenario({ id: "s3" }),
    ]);
    writeJsonl(inputPath, [
      cell({ scenario_id: "s1", programmatic_verdict: "pass", judge_verdict: "n/a" }),
      cell({ scenario_id: "s2", programmatic_verdict: "fail", judge_verdict: "pass" }),
      cell({ scenario_id: "s3", programmatic_verdict: "n/a", judge_verdict: "fail" }),
    ]);

    const judge = vi.fn().mockResolvedValue({ verdict: "fail", explanation: "x" });
    const summary = await rejudge({
      inputPath,
      outputPath,
      corpusPath,
      // biome-ignore lint/suspicious/noExplicitAny: judge is mocked
      judgeModel: {} as any,
      judge,
    });

    expect(summary).toEqual({ total: 3, rejudged: 2, skipped_pass: 1, written: 3 });
    const lines = readFileSync(outputPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
  });
});
