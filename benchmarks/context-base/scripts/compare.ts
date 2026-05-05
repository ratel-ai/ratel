#!/usr/bin/env tsx
/**
 * Generate comparison report from benchmark results.
 *
 * Usage:
 *   tsx scripts/compare.ts                          # scan all subdirs of results/
 *   tsx scripts/compare.ts results/gpt-5-2026-02-16-183000  # specific run folder
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkRunResult } from "../lib/types.js";
import { generateComparisonReport } from "../lib/report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootResultsDir = resolve(__dirname, "..", "results");

function collectJsons(dir: string): BenchmarkRunResult[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")));
}

const targetDir = process.argv[2];

let runs: BenchmarkRunResult[];
let outDir: string;

if (targetDir) {
  const absDir = resolve(targetDir);
  runs = collectJsons(absDir);
  outDir = absDir;
} else {
  // Scan all subdirs + root-level JSONs in results/
  runs = [];
  for (const entry of readdirSync(rootResultsDir)) {
    const full = join(rootResultsDir, entry);
    if (entry.endsWith(".json")) {
      runs.push(JSON.parse(readFileSync(full, "utf-8")));
    } else if (statSync(full).isDirectory()) {
      runs.push(...collectJsons(full));
    }
  }
  outDir = rootResultsDir;
}

if (runs.length === 0) {
  console.error("No result files found.");
  process.exit(1);
}

console.log(`Found ${runs.length} result(s)`);

const md = generateComparisonReport(runs);
const outPath = join(outDir, "comparison.md");
writeFileSync(outPath, md);
console.log(`Comparison written to ${outPath}`);
