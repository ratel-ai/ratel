#!/usr/bin/env tsx
/**
 * Run 3 rounds of benchmarks (oracle, baseline, agentified in parallel per round),
 * then compute avg + stddev for key metrics.
 */
import { exec } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const resultsDir = resolve(rootDir, "results");

const AGENTS = ["oracle", "baseline", "agentified"];
const ROUNDS = 3;

interface RunResult {
  agent: string;
  timestamp: string;
  scenarios: Array<{
    scores: Record<string, number>;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    durationMs: number;
    cost: number;
  }>;
}

// Tag files created by this run
const runTag = Date.now();

async function runRound(round: number) {
  console.log(`\n=== Round ${round + 1}/${ROUNDS} ===`);
  const procs = AGENTS.map((agent) => {
    const cmd = `AGENT_PATH=./agents/${agent}.ts pnpm benchmark 2>&1`;
    console.log(`  Starting ${agent}...`);
    return { agent, promise: runAsync(cmd) };
  });
  const results = await Promise.all(procs.map((p) => p.promise));
  for (let i = 0; i < AGENTS.length; i++) {
    const ok = results[i].includes("passed");
    console.log(`  ${AGENTS[i]}: ${ok ? "PASS" : "FAIL"}`);
    if (!ok) {
      const lines = results[i].split("\n").slice(-20);
      console.log(`    ${lines.join("\n    ")}`);
    }
  }
}

function runAsync(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    exec(cmd, { cwd: rootDir, timeout: 600_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve(stdout || stderr || err?.message || "unknown error");
    });
  });
}

function collectResults(): Map<string, RunResult[]> {
  const files = readdirSync(resultsDir).filter((f) => f.endsWith(".json"));
  const byAgent = new Map<string, RunResult[]>();
  for (const agent of AGENTS) byAgent.set(agent, []);

  // Sort by mtime descending, take latest 3 per agent
  const agentFiles = new Map<string, string[]>();
  for (const agent of AGENTS) agentFiles.set(agent, []);

  for (const f of files) {
    for (const agent of AGENTS) {
      if (f.startsWith(`${agent}-`)) {
        agentFiles.get(agent)!.push(f);
      }
    }
  }

  for (const agent of AGENTS) {
    const sorted = agentFiles.get(agent)!.sort().reverse().slice(0, ROUNDS);
    for (const f of sorted) {
      const data = JSON.parse(readFileSync(resolve(resultsDir, f), "utf-8")) as RunResult;
      byAgent.get(agent)!.push(data);
    }
  }

  return byAgent;
}

function avg(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function stddev(nums: number[]): number {
  const m = avg(nums);
  return Math.sqrt(nums.reduce((sum, n) => sum + (n - m) ** 2, 0) / nums.length);
}

function printStats(byAgent: Map<string, RunResult[]>) {
  console.log("\n\n========================================");
  console.log("       STABILITY ANALYSIS (3 runs)");
  console.log("========================================\n");

  const metrics = [
    { key: "Tool F1", label: "F1", extract: (r: RunResult) => avg(r.scenarios.map((s) => s.scores["Tool F1"] ?? 0)) },
    { key: "Task Correctness", label: "TC", extract: (r: RunResult) => avg(r.scenarios.map((s) => s.scores["Task Correctness"] ?? 0)) },
    { key: "Hydration Recall", label: "HR", extract: (r: RunResult) => avg(r.scenarios.map((s) => s.scores["Hydration Recall"] ?? 0)) },
    { key: "inputTokens", label: "Tot Input", extract: (r: RunResult) => r.scenarios.reduce((s, x) => s + x.inputTokens, 0) },
    { key: "cachedInputTokens", label: "Tot Cached", extract: (r: RunResult) => r.scenarios.reduce((s, x) => s + (x.cachedInputTokens ?? 0), 0) },
    { key: "outputTokens", label: "Tot Output", extract: (r: RunResult) => r.scenarios.reduce((s, x) => s + x.outputTokens, 0) },
    { key: "durationMs", label: "Tot Duration(ms)", extract: (r: RunResult) => r.scenarios.reduce((s, x) => s + x.durationMs, 0) },
  ];

  // Header
  const colW = 18;
  const agentW = 14;
  const header = "Metric".padEnd(colW) + AGENTS.map((a) => a.padStart(agentW * 2 + 3)).join("");
  console.log(header);
  const subHeader = "".padEnd(colW) + AGENTS.map(() => `${"avg".padStart(agentW)}  ${"stddev".padStart(agentW)}`).join("  ");
  console.log(subHeader);
  console.log("-".repeat(colW + AGENTS.length * (agentW * 2 + 5)));

  for (const m of metrics) {
    let line = m.label.padEnd(colW);
    for (const agent of AGENTS) {
      const runs = byAgent.get(agent)!;
      if (runs.length === 0) {
        line += "N/A".padStart(agentW) + "  " + "N/A".padStart(agentW) + "  ";
        continue;
      }
      const values = runs.map(m.extract);
      const a = avg(values);
      const sd = stddev(values);
      const isScore = ["F1", "TC", "HR"].includes(m.label);
      if (isScore) {
        line += a.toFixed(4).padStart(agentW) + "  " + sd.toFixed(4).padStart(agentW) + "  ";
      } else {
        line += Math.round(a).toString().padStart(agentW) + "  " + Math.round(sd).toString().padStart(agentW) + "  ";
      }
    }
    console.log(line);
  }

  // Also show per-run breakdown
  console.log("\n\nPer-run breakdown:");
  for (const agent of AGENTS) {
    const runs = byAgent.get(agent)!;
    console.log(`\n  ${agent} (${runs.length} runs):`);
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      const f1 = avg(r.scenarios.map((s) => s.scores["Tool F1"] ?? 0));
      const tc = avg(r.scenarios.map((s) => s.scores["Task Correctness"] ?? 0));
      const hr = avg(r.scenarios.map((s) => s.scores["Hydration Recall"] ?? 0));
      const totIn = r.scenarios.reduce((s, x) => s + x.inputTokens, 0);
      const totOut = r.scenarios.reduce((s, x) => s + x.outputTokens, 0);
      const totDur = r.scenarios.reduce((s, x) => s + x.durationMs, 0);
      console.log(`    Run ${i + 1}: F1=${f1.toFixed(4)} TC=${tc.toFixed(4)} HR=${hr.toFixed(4)} in=${totIn} out=${totOut} dur=${Math.round(totDur)}ms`);
    }
  }
}

// Main
async function main() {
  // Run rounds sequentially, agents in parallel within each round
  for (let i = 0; i < ROUNDS; i++) {
    await runRound(i);
  }

  const byAgent = collectResults();
  printStats(byAgent);
}

main().catch(console.error);
