// Tiny CLI wrapper around `renderReport`. Reads the agent JSONL plus any
// retrieval JSONL files, joins them, writes REPORT.md. No state of its own —
// all logic lives in `report.ts`.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveRepoPath } from "./paths.js";
import { type RetrievalRow, renderReport } from "./report.js";
import type { CellResult } from "./types.js";

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split("\n");
  const out: T[] = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    out.push(JSON.parse(l) as T);
  }
  return out;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function multiArg(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length - 1; i++) {
    if (process.argv[i] === name) out.push(process.argv[i + 1]);
  }
  return out;
}

/** Default retrieval sources when `--retrieval` isn't given: every file ending
 *  in `retrieval.jsonl` under `benchmark/results/`. Picks up `retrieval.jsonl`,
 *  `metatool-retrieval.jsonl`, future `toolret-retrieval.jsonl`, etc. */
function discoverRetrievalFiles(): string[] {
  const dir = resolveRepoPath("benchmark/results");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith("retrieval.jsonl"))
    .map((f) => join(dir, f))
    .sort();
}

const agentPath = resolveRepoPath(arg("--agent", "benchmark/agent/results/agent.jsonl"));
const explicit = multiArg("--retrieval");
const retrievalPaths =
  explicit.length > 0 ? explicit.map((p) => resolveRepoPath(p)) : discoverRetrievalFiles();
const outputPath = resolveRepoPath(arg("--output", "benchmark/results/REPORT.md"));

const cells = readJsonl<CellResult>(agentPath);
const retrieval = retrievalPaths.flatMap((p) => readJsonl<RetrievalRow>(p));
const md = renderReport({ cells, retrieval });

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, md, "utf-8");
console.log(
  `wrote ${outputPath} (${cells.length} cells, ${retrieval.length} retrieval rows from ${retrievalPaths.length} file${retrievalPaths.length === 1 ? "" : "s"})`,
);
