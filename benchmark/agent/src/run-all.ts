// Unified entrypoint for the benchmark suite. Drives both retrieval modes
// (MetaTool + ToolRet, the Rust crate) and — once shipped — the agent campaign
// (mode (c)), then emits the merged REPORT.md.
//
// Behavior:
//   1. Ingest each corpus if its normalized JSONL is missing (`--download`).
//   2. Run BM25 retrieval over each corpus at corpus-appropriate pool sizes.
//   3. Mode (c): print a "not yet implemented" notice and skip.
//   4. Render REPORT.md from the retrieval JSONLs (and agent.jsonl when present).
//
// Flags:
//   --force         re-ingest even if the snapshot already exists
//   --skip-ingest   never call the ingest CLI (fail loudly if missing)
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

function modeCNotice(): void {
  console.log(
    "\n→ mode (c) — agent campaign\n" +
      "  not yet implemented (see progress.md). When mode (c) ships, this orchestrator " +
      "will invoke the agent runner here before the report step.",
  );
}

function report(): void {
  // Re-uses the existing report CLI; auto-discovers `*retrieval.jsonl` under
  // `benchmark/results/` and joins with `agent.jsonl` if present.
  runStep("render REPORT.md", "pnpm", ["-F", "@ratel-ai/benchmark", "report"]);
}

function main(): void {
  const force = hasFlag("--force");
  const skipIngest = hasFlag("--skip-ingest");
  const only = flagValue("--only") as CorpusName | undefined;

  const targets = only ? CORPORA.filter((c) => c.name === only) : CORPORA;
  if (only && targets.length === 0) {
    throw new Error(`unknown --only value: ${only} (expected metatool | toolret)`);
  }

  for (const spec of targets) {
    ingest(spec, force, skipIngest);
    retrieval(spec);
  }

  modeCNotice();
  report();

  console.log("\n✓ benchmark run-all complete.");
}

try {
  main();
} catch (err) {
  console.error(`\n✗ ${(err as Error).message}`);
  process.exit(1);
}
