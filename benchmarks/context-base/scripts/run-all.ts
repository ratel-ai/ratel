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
import { Agent } from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

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

interface AgentEntry {
  name: string;
  cmd: string;
}

function discoverAgents(): AgentEntry[] {
  const entries: AgentEntry[] = [];
  const tsDir = resolve(rootDir, "agents", "ts");
  const pyDir = resolve(rootDir, "agents", "py");

  if (existsSync(tsDir)) {
    for (const f of readdirSync(tsDir)) {
      if (f.endsWith(".ts") && !f.includes(".test.") && !f.startsWith("__")) {
        entries.push({ name: f, cmd: `tsx agents/ts/${f}` });
      }
    }
  }

  if (existsSync(pyDir)) {
    for (const f of readdirSync(pyDir)) {
      if (f.endsWith(".py") && !f.startsWith("__")) {
        entries.push({ name: f, cmd: `python agents/py/${f}` });
      }
    }
  }

  // claude-tool-search agent only works with Claude models
  if (!model.startsWith("claude-")) {
    return entries.filter((e) => !e.name.includes("claude-tool-search"));
  }

  return entries;
}

const agents = discoverAgents();
const agentNames = agents.map((a) => a.name);
const totalScenarios = scenarios.filter((s) => !s.skip).length;

console.log(`Model: ${model}`);
console.log(`Agents: ${agentNames.join(", ")}`);
console.log(`Scenarios: ${totalScenarios}`);
console.log(`Results: ${runDir}\n`);

interface AgentProgress {
  completed: number;
  f1Avg: number;
  tcAvg: number;
  hrAvg: number;
  timeAvg: number;
  costSum: number;
  isComplete: boolean;
}

function parseJsonl(path: string): ScenarioResult[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  const results: ScenarioResult[] = [];
  for (const line of lines) {
    try { results.push(JSON.parse(line)); } catch { }
  }
  return results;
}

const progress: Record<string, AgentProgress> = {};
function pollProgress(totalScenarios: number): Record<string, AgentProgress> {
  for (const name of agentNames) {
    if (progress[name] && progress[name].isComplete) {
      continue;
    }

    const results = parseJsonl(resolve(runDir, `${name}.jsonl`));
    const n = results.length;

    if (n === 0) {
      progress[name] = { completed: 0, f1Avg: 0, tcAvg: 0, hrAvg: 0, timeAvg: 0, costSum: 0, isComplete: false };
      continue;
    }

    let f1Sum = 0, tcSum = 0, hrSum = 0, timeSum = 0, costSum = 0;
    for (const r of results) {
      f1Sum += r.scores["Tool F1"] ?? 0;
      tcSum += r.scores["Task Correctness"] ?? 0;
      hrSum += r.scores["Hydration Recall"] ?? 0;
      timeSum += r.durationMs ?? 0;
      costSum += r.cost;
    }

    progress[name] = { completed: n, f1Avg: f1Sum / n, tcAvg: tcSum / n, hrAvg: hrSum / n, timeAvg: timeSum / n, costSum, isComplete: n >= totalScenarios };
  }
  return progress;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

let dashboardRendered = false;

function renderDashboard(startMs: number): void {
  const elapsedMs = performance.now() - startMs;
  const progress = pollProgress(totalScenarios);
  const maxName = Math.max(...agentNames.map((a) => a.length));

  if (dashboardRendered) process.stdout.write(`\x1b[${agentNames.length}A`);

  for (const name of agentNames) {
    const p = progress[name] as AgentProgress | undefined;
    const padded = name.padEnd(maxName);
    const completedScenarios = p?.completed ?? 0;
    const count = `${String(completedScenarios).padStart(2)}/${totalScenarios}`;
    const line = p && completedScenarios > 0
      ? `  ${padded}  ${count} | F1 ${p.f1Avg.toFixed(2)} | TC ${p.tcAvg.toFixed(2)} | HR ${p.hrAvg.toFixed(2)} | $${p.costSum.toFixed(2).padStart(5)} | Avg time: ${formatElapsed(p.timeAvg)} | ${p.completed >= totalScenarios ? `${formatElapsed(p.completed * p.timeAvg)} ✅` : formatElapsed(elapsedMs)}`
      : `  ${padded}  ${count} | waiting... | ${formatElapsed(elapsedMs)}`;
    process.stdout.write(`\x1b[2K${line}\n`);
  }
  dashboardRendered = true;
}

function runAgent(entry: AgentEntry): Promise<{ name: string; logPath: string; ok: boolean }> {
  const logPath = resolve(runDir, `${entry.name}.log`);
  const logStream = createWriteStream(logPath);
  return new Promise((res) => {
    const child = spawn("pnpm", ["benchmark"], {
      cwd: rootDir,
      env: { ...process.env, MODEL: model, AGENT_CMD: entry.cmd, RESULTS_DIR: runDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    child.on("close", (code) => {
      logStream.end();
      res({ name: entry.name, logPath, ok: code === 0 });
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
  renderDashboard(start);
  showCursor();

  console.log();
  for (const r of results) {
    const icon = r.ok ? "PASS" : "FAIL";
    console.log(`  ${r.name}: ${icon}`);
    if (!r.ok) {
      const log = readFileSync(r.logPath, "utf-8");
      const tail = log.split("\n").slice(-15).join("\n");
      console.log(`    ${tail}\n`);
    }
  }
  console.log(`Logs: ${runDir}/*.log`);

  const elapsed = ((performance.now() - start) / 1000).toFixed(1);
  console.log(`\nAll agents finished in ${elapsed}s\n`);

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
