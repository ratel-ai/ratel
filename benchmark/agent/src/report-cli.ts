// Tiny CLI wrapper around `renderReport`. Reads the two JSONL files, joins
// them, writes REPORT.md. No state of its own — all logic lives in `report.ts`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

const agentPath = resolveRepoPath(arg("--agent", "benchmark/agent/results/agent.jsonl"));
const retrievalPath = resolveRepoPath(arg("--retrieval", "benchmark/results/retrieval.jsonl"));
const outputPath = resolveRepoPath(arg("--output", "benchmark/results/REPORT.md"));

const cells = readJsonl<CellResult>(agentPath);
const retrieval = readJsonl<RetrievalRow>(retrievalPath);
const md = renderReport({ cells, retrieval });

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, md, "utf-8");
console.log(`wrote ${outputPath} (${cells.length} cells, ${retrieval.length} retrieval rows)`);
