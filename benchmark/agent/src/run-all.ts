// Unified entrypoint for the benchmark suite. Drives both retrieval modes
// (MetaTool + ToolRet, the Rust crate), then the agent campaign (mode (c)) if
// at least one provider key is set, then emits the merged REPORT.md.
//
// Behavior:
//   1. Ingest each corpus if its normalized JSONL is missing (`--download`).
//   2. Run BM25 retrieval over each corpus at corpus-appropriate pool sizes.
//   3. If `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` is set (and `--skip-agent` is
//      not), spawn the agent campaign with conservative defaults — small
//      sampled subset, 1 run/cell, all three arms, $5 global cap. Skipped with
//      a notice otherwise so the rest of run-all stays $0 and CI-friendly.
//   4. Render REPORT.md from the retrieval JSONLs (and agent.jsonl when present).
//
// Flags:
//   --force         re-ingest even if the snapshot already exists
//   --skip-ingest   never call the ingest CLI (fail loudly if missing)
//   --skip-agent    never run mode (c), even if a provider key is present
//   --only NAME     restrict to a single corpus: "metatool" | "toolret"

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { REPO_ROOT, resolveRepoPath } from "./paths.js";

type CorpusName = "metatool" | "toolret";

interface CorpusSpec {
  name: CorpusName;
  corpus: string;
  retrievalOut: string;
  poolSizes: string;
  topK: string;
}

const CORPORA: CorpusSpec[] = [
  {
    name: "metatool",
    corpus: "benchmark/test-data/metatool.jsonl",
    retrievalOut: "benchmark/results/metatool-retrieval.jsonl",
    // MetaTool's gold-tool universe ceiling is ~199 plugins; pool sizes stay at
    // or below it so every cell is meaningful.
    poolSizes: "30,100,180",
    topK: "1,3,5,10",
  },
  {
    name: "toolret",
    corpus: "benchmark/test-data/toolret.jsonl",
    retrievalOut: "benchmark/results/toolret-retrieval.jsonl",
    // ToolRet's gold-only universe is ~7,651 unique tools — small / mid / full.
    poolSizes: "100,1000,7000",
    topK: "1,3,5,10",
  },
];

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

function runStep(label: string, bin: string, args: string[]): void {
  console.log(`\n→ ${label}`);
  console.log(`  $ ${bin} ${args.join(" ")}`);
  const res = spawnSync(bin, args, { stdio: "inherit", cwd: REPO_ROOT });
  if (res.status !== 0) {
    throw new Error(`${label} failed (exit ${res.status ?? "?"})`);
  }
}

function isNonEmptyDir(p: string): boolean {
  try {
    return statSync(p).isDirectory() && readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

function ingest(spec: CorpusSpec, force: boolean, skipIngest: boolean): void {
  const absCorpus = resolveRepoPath(spec.corpus);
  if (existsSync(absCorpus) && !force) {
    console.log(`✓ ${spec.name}: corpus present at ${spec.corpus}, skipping ingest`);
    return;
  }
  if (skipIngest) {
    throw new Error(
      `${spec.name}: ${spec.corpus} missing and --skip-ingest set. ` +
        `Run \`cargo run -p ratel-benchmark-retrieval --release -- ingest ${spec.name} --download\` first.`,
    );
  }
  // Re-use cached upstream fixtures when present — only call `--download` on a
  // truly clean clone or with `--force`.
  const fixturesDir = resolveRepoPath(`benchmark/fixtures/${spec.name}`);
  const args = ["run", "-p", "ratel-benchmark-retrieval", "--release", "--", "ingest", spec.name];
  if (force || !isNonEmptyDir(fixturesDir)) {
    args.push("--download");
  } else {
    console.log(`  (fixtures cached at ${fixturesDir} — skipping --download)`);
  }
  runStep(`ingest ${spec.name}`, "cargo", args);
}

function retrieval(spec: CorpusSpec): void {
  runStep(`retrieval ${spec.name}`, "cargo", [
    "run",
    "-p",
    "ratel-benchmark-retrieval",
    "--release",
    "--",
    "retrieval",
    "--corpus",
    spec.corpus,
    "--output",
    spec.retrievalOut,
    "--top-k",
    spec.topK,
    "--pool-sizes",
    spec.poolSizes,
  ]);
}

/**
 * Mode (c) — agent campaign. Gated on a provider key being available, so a
 * clean clone with no `.env` still runs the free retrieval modes + report.
 *
 * The `--skip-agent` flag short-circuits this even when keys are present (e.g.
 * for a fast iteration on the report layout). Defaults are deliberately
 * conservative — a developer iterating locally shouldn't blow $25 by typing
 * `pnpm run-all`. The first headline campaign is launched explicitly via
 * `pnpm -F @ratel-ai/benchmark start --runs 5 ...` (see agent/README.md).
 */
function agentCampaign(skipAgent: boolean): void {
  if (skipAgent) {
    console.log("\n→ mode (c) — agent campaign\n  --skip-agent set, skipping.");
    return;
  }
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  if (!hasOpenAI && !hasAnthropic) {
    console.log(
      "\n→ mode (c) — agent campaign\n" +
        "  no provider key set (OPENAI_API_KEY / ANTHROPIC_API_KEY). Skipping. " +
        "Set one and re-run, or invoke `pnpm -F @ratel-ai/benchmark start ...` directly.",
    );
    return;
  }
  const models: string[] = [];
  if (hasAnthropic) models.push("claude-sonnet-4-6");
  if (hasOpenAI) models.push("gpt-5.4-mini");

  // Conservative defaults for an automated invocation: small sampled subset,
  // 1 run per cell, all three arms (so the report has the full picture), $5 cap.
  // Override these by calling `pnpm -F @ratel-ai/benchmark start` directly.
  runStep("agent campaign (mode c)", "pnpm", [
    "-F",
    "@ratel-ai/benchmark",
    "start",
    "--scenarios",
    "50",
    "--runs",
    "1",
    "--arms",
    "control,hybrid,oracle",
    "--models",
    models.join(","),
    "--pool-size",
    "180",
    "--dollar-global",
    "5",
    "--concurrency",
    "10",
    "--quiet",
  ]);
}

function report(): void {
  // Re-uses the existing report CLI; auto-discovers `*retrieval.jsonl` under
  // `benchmark/results/` and joins with `agent.jsonl` if present.
  runStep("render REPORT.md", "pnpm", ["-F", "@ratel-ai/benchmark", "report"]);
}

function main(): void {
  const force = hasFlag("--force");
  const skipIngest = hasFlag("--skip-ingest");
  const skipAgent = hasFlag("--skip-agent");
  const only = flagValue("--only") as CorpusName | undefined;

  const targets = only ? CORPORA.filter((c) => c.name === only) : CORPORA;
  if (only && targets.length === 0) {
    throw new Error(`unknown --only value: ${only} (expected metatool | toolret)`);
  }

  for (const spec of targets) {
    ingest(spec, force, skipIngest);
    retrieval(spec);
  }

  agentCampaign(skipAgent);
  report();

  console.log("\n✓ benchmark run-all complete.");
}

try {
  main();
} catch (err) {
  console.error(`\n✗ ${(err as Error).message}`);
  process.exit(1);
}
