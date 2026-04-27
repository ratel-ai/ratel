// FinanceBot showcase — runs the canned task ("investigate anomalous transactions →
// CFO memo") TWICE against a real LLM, with real tool execution, and writes real recordings.
//
// Mode A (raw): all 100 tool schemas exposed to the model on every step.
// Mode B (agentified): only `agentified_discover` is active initially; the model discovers
//   the right tools, prepareStep activates them, and the model proceeds with a curated set.
//
// Both runs:
//   - Use the same model + same prompt + same tool implementations.
//   - Capture: tools_loaded (active tools at run start), tool_calls (full list with outcomes),
//     real input/output tokens, real wall-clock, real cost in USD at gpt-4o-mini rates.
//   - Write to ./recordings/{raw,agentified}.json — picked up by `agentified inspect`.
//
// Requirements:
//   - OPENAI_API_KEY in env or in <repo-root>/.env
//   - agentified-core running on AGENTIFIED_URL (default http://localhost:9119)
//
// Run:
//   pnpm install && pnpm start

import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

import { Agentified, type BackendTool } from "agentified";
import { aiSdk } from "@agentified/ai-sdk";
import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs, type ModelMessage, type ToolSet } from "ai";

import { tools as allTools, toolBuckets } from "./tools.js";
import { skills } from "./skills.js";

// --- Config -----------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Load env from worktree root (../../.env from this file's location), matching ts-ai-sdk-smoke.
dotenv.config({ path: resolve(__dirname, "../../../.env") });
dotenv.config({ path: resolve(__dirname, "../../../../.env") });

const SERVER = process.env.AGENTIFIED_URL ?? "http://localhost:9119";
const DATASET = process.env.AGENTIFIED_DATASET ?? "financebot";
const MODEL = process.env.FINANCEBOT_MODEL ?? "gpt-4o-mini";
const MAX_STEPS = Number(process.env.FINANCEBOT_MAX_STEPS ?? 14);

if (!process.env.OPENAI_API_KEY) {
  console.error("ERROR: OPENAI_API_KEY is not set. Put it in <repo-root>/.env or your shell.");
  process.exit(1);
}

// gpt-4o-mini pricing (April 2026): $0.15/1M input, $0.60/1M output.
// Override via env if you point at a different model.
const PRICE_INPUT_PER_M = Number(process.env.FINANCEBOT_PRICE_INPUT ?? 0.15);
const PRICE_OUTPUT_PER_M = Number(process.env.FINANCEBOT_PRICE_OUTPUT ?? 0.60);

const TASK_PROMPT = [
  "You are FinanceBot, an AP/controller assistant for a small finance team. Today's date is 2026-04-27.",
  "",
  "Investigate anomalous transactions from the last 7 days, gather supporting context for each (vendor profile, applicable policy), then draft a CFO memo summarizing findings and recommended dispositions, and email it to cfo@finance.example.com.",
  "",
  "Use only tools that match the task. Be concise: a few targeted tool calls, then the memo.",
].join("\n");

// --- Recording type ---------------------------------------------------------

interface Recording {
  label: string;
  task: string;
  metrics: {
    tools_loaded: number;
    tool_calls: number;
    skill_activations: number;
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    estimated_cost_usd: number;
    wall_clock_seconds: number;
    reliability_score: number;
  };
  skills: Array<{ name: string; atoms_used: number; atoms_total: number }>;
  tool_calls: Array<{ name: string; duration_ms: number; outcome: "success" | "fail" | "retry" }>;
  suggestions: Array<{ name: string; reason: string }>;
  reliability_issues: Array<{ tool: string; kind: string; detail: string }>;
  timeline: Array<{ t: string; label: string; ms: number }>;
  final_text?: string;
}

// --- Helpers ----------------------------------------------------------------

function fmtTimeOffset(startMs: number, atMs: number): string {
  const sec = Math.max(0, Math.round((atMs - startMs) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function dollars(input: number, output: number): number {
  return input * (PRICE_INPUT_PER_M / 1_000_000) + output * (PRICE_OUTPUT_PER_M / 1_000_000);
}

// Build an instrumented copy of `allTools` so we can record per-call latency and outcomes.
type CallEvent = {
  name: string;
  startMs: number;
  durationMs: number;
  outcome: "success" | "fail" | "retry";
  args: unknown;
  resultPreview: string;
};
function instrument(tools: BackendTool[], sink: CallEvent[]): BackendTool[] {
  return tools.map((t) => ({
    ...t,
    handler: async (args) => {
      const start = Date.now();
      try {
        const out = await t.handler(args);
        const ev: CallEvent = {
          name: t.name,
          startMs: start,
          durationMs: Date.now() - start,
          outcome: typeof out === "object" && out && "error" in (out as object) ? "fail" : "success",
          args,
          resultPreview: JSON.stringify(out).slice(0, 80),
        };
        sink.push(ev);
        return out;
      } catch (e) {
        const ev: CallEvent = {
          name: t.name,
          startMs: start,
          durationMs: Date.now() - start,
          outcome: "fail",
          args,
          resultPreview: String(e),
        };
        sink.push(ev);
        throw e;
      }
    },
  }));
}

// --- Run modes --------------------------------------------------------------

async function runRaw(): Promise<Recording> {
  console.log("\n[mode: raw]   100 tools dumped to the model on every step");
  const calls: CallEvent[] = [];
  const instrumented = instrument(allTools, calls);

  const ag = new Agentified();
  await ag.connect(SERVER);
  const aag = ag.adaptTo(aiSdk());
  const dataset = aag.dataset(DATASET);
  const instance = await dataset.register({ tools: instrumented });
  await instance.registerSkills(skills);

  // Strip the discover tool — raw run is just the 100 backend tools, no Agentified curation.
  const { agentified_discover: _drop, ...rawTools } = instance.tools;

  const start = Date.now();
  const messages: ModelMessage[] = [{ role: "user", content: TASK_PROMPT }];
  const result = await generateText({
    model: openai(MODEL),
    tools: rawTools as unknown as ToolSet,
    messages,
    stopWhen: stepCountIs(MAX_STEPS),
  });
  const elapsedMs = Date.now() - start;

  const usage = result.totalUsage ?? result.usage ?? { inputTokens: 0, outputTokens: 0 };
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;

  await ag.disconnect();

  const failed = calls.filter((c) => c.outcome === "fail").length;
  return {
    label: "Raw — 100 tools dumped to the model",
    task: TASK_PROMPT,
    metrics: {
      tools_loaded: Object.keys(rawTools).length,
      tool_calls: calls.length,
      skill_activations: 0,
      total_tokens: inputTokens + outputTokens,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated_cost_usd: dollars(inputTokens, outputTokens),
      wall_clock_seconds: Number((elapsedMs / 1000).toFixed(2)),
      reliability_score: calls.length === 0 ? 1 : Number(((calls.length - failed) / calls.length).toFixed(2)),
    },
    skills: [],
    tool_calls: calls.map((c) => ({ name: c.name, duration_ms: c.durationMs, outcome: c.outcome })),
    suggestions: suggestSkillsFromCalls(calls),
    reliability_issues: calls
      .filter((c) => c.outcome === "fail")
      .map((c) => ({ tool: c.name, kind: "fail", detail: c.resultPreview })),
    timeline: [
      { t: "00:00", label: `Loaded ${Object.keys(rawTools).length} tools (~${inputTokens} input tokens across ${result.steps.length} steps)`, ms: 0 },
      ...calls.map((c) => ({
        t: fmtTimeOffset(start, c.startMs),
        label: c.outcome === "success" ? c.name : `${c.name} (${c.outcome})`,
        ms: c.durationMs,
      })),
    ],
    final_text: result.text,
  };
}

async function runAgentified(): Promise<Recording> {
  console.log("\n[mode: agentified]   discover → curated tool set");
  const calls: CallEvent[] = [];
  const instrumented = instrument(allTools, calls);

  const ag = new Agentified();
  await ag.connect(SERVER);
  const aag = ag.adaptTo(aiSdk());
  const dataset = aag.dataset(DATASET);
  const instance = await dataset.register({ tools: instrumented });
  await instance.registerSkills(skills);
  const sess = instance.session(`anomaly-${Date.now()}`);

  // Build the curated context: all tool implementations are registered (so prepareStep can
  // activate them), but only `agentified_discover` is active to start.
  const ctx = await sess.context.tools({ agentified_discover: sess.discoverTool }).assemble();

  const start = Date.now();
  const messages: ModelMessage[] = [{ role: "user", content: TASK_PROMPT }];
  const result = await generateText({
    model: openai(MODEL),
    tools: ctx.tools as unknown as ToolSet,
    prepareStep: ctx.prepareStep,
    messages,
    stopWhen: stepCountIs(MAX_STEPS),
  });
  const elapsedMs = Date.now() - start;

  const usage = result.totalUsage ?? result.usage ?? { inputTokens: 0, outputTokens: 0 };
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;

  // Skill activations: count which registered skills had ALL their atoms called.
  const calledNames = new Set(calls.map((c) => c.name));
  const skillActivations = skills
    .filter((s) => s.atoms.every((a) => calledNames.has(a)))
    .map((s) => ({ name: s.name, atoms_used: s.atoms.length, atoms_total: s.atoms.length }));

  // What we ended up loading (non-discover tools the agent actually saw): proxy with the
  // unique set of tool names that fired (everything else was hidden by prepareStep).
  const discoveredNames = new Set(calls.map((c) => c.name).filter((n) => n !== "agentified_discover"));
  const toolsLoaded = discoveredNames.size + 1; // + agentified_discover itself

  await ag.disconnect();

  const failed = calls.filter((c) => c.outcome === "fail").length;
  return {
    label: "Agentified-curated — discover-then-act",
    task: TASK_PROMPT,
    metrics: {
      tools_loaded: toolsLoaded,
      tool_calls: calls.length,
      skill_activations: skillActivations.length,
      total_tokens: inputTokens + outputTokens,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated_cost_usd: dollars(inputTokens, outputTokens),
      wall_clock_seconds: Number((elapsedMs / 1000).toFixed(2)),
      reliability_score: calls.length === 0 ? 1 : Number(((calls.length - failed) / calls.length).toFixed(2)),
    },
    skills: skillActivations,
    tool_calls: calls.map((c) => ({ name: c.name, duration_ms: c.durationMs, outcome: c.outcome })),
    suggestions: suggestSkillsFromCalls(calls),
    reliability_issues: calls
      .filter((c) => c.outcome === "fail")
      .map((c) => ({ tool: c.name, kind: "fail", detail: c.resultPreview })),
    timeline: [
      { t: "00:00", label: `Loaded ${toolsLoaded} tools (discover + ${discoveredNames.size} discovered, ~${inputTokens} input tokens across ${result.steps.length} steps)`, ms: 0 },
      ...calls.map((c) => ({
        t: fmtTimeOffset(start, c.startMs),
        label: c.outcome === "success" ? c.name : `${c.name} (${c.outcome})`,
        ms: c.durationMs,
      })),
    ],
    final_text: result.text,
  };
}

// Naive co-occurrence suggester: any 3+ tools that fired in this run that aren't already a
// registered skill is surfaced as a candidate skill.
function suggestSkillsFromCalls(calls: CallEvent[]): Array<{ name: string; reason: string }> {
  if (calls.length < 3) return [];
  const names = Array.from(new Set(calls.map((c) => c.name)));
  const isExistingSkill = skills.some((s) => names.every((n) => s.atoms.includes(n)));
  if (isExistingSkill || names.length < 3) return [];
  const composedName = names
    .slice(0, 3)
    .map((n) => n.split("_").pop())
    .filter(Boolean)
    .join("_to_");
  return [
    {
      name: `propose_${composedName}`,
      reason: `${names.length} tools fired together in one run: ${names.join(", ")}. Consider promoting to a skill.`,
    },
  ];
}

// --- Entrypoint -------------------------------------------------------------

async function main() {
  console.log(`FinanceBot showcase`);
  console.log(`  server: ${SERVER}`);
  console.log(`  dataset: ${DATASET}`);
  console.log(`  model: ${MODEL}`);
  console.log(`  registered tools: ${allTools.length} (ledger=${toolBuckets.ledger}, crm=${toolBuckets.crm}, docsComms=${toolBuckets.docsComms}, misc=${toolBuckets.misc})`);
  console.log(`  registered skills: ${skills.length}`);

  const raw = await runRaw();
  const agentified = await runAgentified();

  const recordingsDir = resolve(__dirname, "../recordings");
  mkdirSync(recordingsDir, { recursive: true });
  writeFileSync(resolve(recordingsDir, "raw.json"), JSON.stringify(raw, null, 2) + "\n");
  writeFileSync(resolve(recordingsDir, "agentified.json"), JSON.stringify(agentified, null, 2) + "\n");

  console.log("\n--- Side-by-side ---");
  console.log(`                         raw          agentified`);
  console.log(`  tools loaded         ${pad(raw.metrics.tools_loaded)}        ${pad(agentified.metrics.tools_loaded)}`);
  console.log(`  tool calls           ${pad(raw.metrics.tool_calls)}        ${pad(agentified.metrics.tool_calls)}`);
  console.log(`  input tokens         ${pad(raw.metrics.input_tokens)}     ${pad(agentified.metrics.input_tokens)}`);
  console.log(`  output tokens        ${pad(raw.metrics.output_tokens)}     ${pad(agentified.metrics.output_tokens)}`);
  console.log(`  total tokens         ${pad(raw.metrics.total_tokens)}     ${pad(agentified.metrics.total_tokens)}`);
  console.log(`  estimated cost (USD) $${raw.metrics.estimated_cost_usd.toFixed(4)}      $${agentified.metrics.estimated_cost_usd.toFixed(4)}`);
  console.log(`  wall clock (s)       ${pad(raw.metrics.wall_clock_seconds)}        ${pad(agentified.metrics.wall_clock_seconds)}`);
  console.log(`  reliability score    ${pad(raw.metrics.reliability_score)}        ${pad(agentified.metrics.reliability_score)}`);
  console.log(`  skill activations    ${pad(raw.metrics.skill_activations)}        ${pad(agentified.metrics.skill_activations)}`);
  console.log(`\nRecordings → ${recordingsDir}`);
  console.log(`Open the inspector: agentified inspect --recordings ${recordingsDir}`);
}

function pad(v: unknown, w = 9): string {
  return String(v).padEnd(w);
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
