#!/usr/bin/env tsx
/**
 * Run benchmarks for all agents in parallel on a given model, then print comparison report.
 *
 * Usage: tsx scripts/run-all.ts <model>
 *   e.g. tsx scripts/run-all.ts gpt-5
 *        tsx scripts/run-all.ts claude-sonnet-4-5-20250929
 *        tsx scripts/run-all.ts gemini-3-flash-preview
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkRunResult, ScenarioResult } from "../lib/types.js";
import { generateComparisonReport } from "../lib/report.js";
import { PRICING } from "../lib/constants.js";
import { scenarios } from "../scenarios/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const agentsDir = resolve(rootDir, "agents");

const model = process.argv[2];
if (!model) {
  console.error("Usage: tsx scripts/run-all.ts <model>");
  console.error(`Available models: ${Object.keys(PRICING).join(", ")}`);
  process.exit(1);
}

if (!PRICING[model]) {
  console.error(`Unknown model "${model}". Available: ${Object.keys(PRICING).join(", ")}`);
  process.exit(1);
}

function formatDatetime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const runDir = resolve(rootDir, "results", `${formatDatetime(new Date())}-${model}`);
mkdirSync(runDir, { recursive: true });

const agents = readdirSync(agentsDir)
  .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
  .map((f) => f.replace(/\.ts$/, ""));

const totalScenarios = scenarios.filter((s) => !s.skip).length;

console.log(`Model: ${model}`);
console.log(`Agents: ${agents.join(", ")}`);
console.log(`Scenarios: ${totalScenarios}`);
console.log(`Results: ${runDir}\n`);

interface AgentProgress {
  completed: number;
  f1Avg: number;
  tcAvg: number;
  hrAvg: number;
  costSum: number;
}

function parseJsonl(path: string): ScenarioResult[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  const results: ScenarioResult[] = [];
  for (const line of lines) {
    try { results.push(JSON.parse(line)); } catch {}
  }
  return results;
}

function pollProgress(): Map<string, AgentProgress> {
  const progress = new Map<string, AgentProgress>();
  for (const agent of agents) {
    const results = parseJsonl(resolve(runDir, `${agent}.jsonl`));
    const n = results.length;
    if (n === 0) {
      progress.set(agent, { completed: 0, f1Avg: 0, tcAvg: 0, hrAvg: 0, costSum: 0 });
      continue;
    }
    let f1Sum = 0, tcSum = 0, hrSum = 0, costSum = 0;
    for (const r of results) {
      f1Sum += r.scores["Tool F1"] ?? 0;
      tcSum += r.scores["Task Correctness"] ?? 0;
      hrSum += r.scores["Hydration Recall"] ?? 0;
      costSum += r.cost;
    }
    progress.set(agent, {
      completed: n,
      f1Avg: f1Sum / n,
      tcAvg: tcSum / n,
      hrAvg: hrSum / n,
      costSum,
    });
  }
  return progress;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function renderDashboard(startMs: number): void {
  const progress = pollProgress();
  const elapsed = formatElapsed(performance.now() - startMs);
  const maxName = Math.max(...agents.map((a) => a.length));

  // Move cursor up to overwrite previous dashboard
  if (dashboardRendered) process.stdout.write(`\x1b[${agents.length}A`);

  for (const agent of agents) {
    const p = progress.get(agent)!;
    const name = agent.padEnd(maxName);
    const count = `${String(p.completed).padStart(2)}/${totalScenarios}`;
    const line = p.completed > 0
      ? `  ${name}  ${count} | F1 ${p.f1Avg.toFixed(2)} | TC ${p.tcAvg.toFixed(2)} | HR ${p.hrAvg.toFixed(2)} | $${p.costSum.toFixed(2).padStart(5)} | ${elapsed}`
      : `  ${name}  ${count} | waiting... | ${elapsed}`;
    process.stdout.write(`\x1b[2K${line}\n`);
  }
  dashboardRendered = true;
}

let dashboardRendered = false;

function runAgent(agent: string): Promise<{ agent: string; logPath: string; ok: boolean }> {
  const logPath = resolve(runDir, `${agent}.log`);
  const logStream = createWriteStream(logPath);
  return new Promise((res) => {
    const child = spawn("pnpm", ["benchmark"], {
      cwd: rootDir,
      env: { ...process.env, MODEL: model, AGENT_PATH: `./agents/${agent}.ts`, RESULTS_DIR: runDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    child.on("close", (code) => {
      logStream.end();
      res({ agent, logPath, ok: code === 0 });
    });
  });
}

function hideCursor() { process.stdout.write("\x1b[?25l"); }
function showCursor() { process.stdout.write("\x1b[?25h"); }

async function main() {
  const start = performance.now();

  hideCursor();
  process.on("SIGINT", () => { showCursor(); process.exit(130); });

  console.log(`Starting all agents in parallel...`);
  console.log(`  tail -f ${runDir}/<agent>.log\n`);
  const timer = setInterval(() => renderDashboard(start), 1000);

  const results = await Promise.all(agents.map(runAgent));

  clearInterval(timer);
  renderDashboard(start); // final render
  showCursor();

  console.log();
  for (const r of results) {
    const icon = r.ok ? "PASS" : "FAIL";
    console.log(`  ${r.agent}: ${icon}`);
    if (!r.ok) {
      const log = readFileSync(r.logPath, "utf-8");
      const tail = log.split("\n").slice(-15).join("\n");
      console.log(`    ${tail}\n`);
    }
  }
  console.log(`Logs: ${runDir}/*.log`);

  const elapsed = ((performance.now() - start) / 1000).toFixed(1);
  console.log(`\nAll agents finished in ${elapsed}s\n`);

  // Collect results from run folder
  const files = readdirSync(runDir).filter((f) => f.endsWith(".json"));
  const runs: BenchmarkRunResult[] = files.map((f) =>
    JSON.parse(readFileSync(resolve(runDir, f), "utf-8")),
  );

  if (runs.length === 0) {
    console.error("No results collected. Aborting.");
    process.exit(1);
  }

  const recap = generateComparisonReport(runs);
  writeFileSync(resolve(runDir, "recap.md"), recap);
  console.log(`Recap written to ${runDir}/recap.md\n`);
  console.log(recap);
}

main().catch((err) => {
  showCursor();
  console.error(err);
  process.exit(1);
});
