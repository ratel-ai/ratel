import { readFileSync } from "node:fs";
import { checkThresholds, type EvaliteExportedOutput, type ThresholdConfig } from "../lib/ci-threshold.js";

const DEFAULT_THRESHOLDS: ThresholdConfig = {
  "Tool F1": 0.3,
  "Action Correctness": 0.8,
  "Negative Correctness": 0.8,
};

const resultsPath = process.argv[2] ?? "./benchmark-results.json";

let output: EvaliteExportedOutput;
try {
  output = JSON.parse(readFileSync(resultsPath, "utf-8"));
} catch {
  console.error(`Failed to read results from ${resultsPath}`);
  process.exit(1);
}

const thresholds: ThresholdConfig = process.env.BENCHMARK_THRESHOLDS
  ? JSON.parse(process.env.BENCHMARK_THRESHOLDS)
  : DEFAULT_THRESHOLDS;

const { passed, details } = checkThresholds(output, thresholds);

console.log("\n=== Benchmark Threshold Check ===\n");
for (const d of details) {
  const icon = d.passed ? "PASS" : "FAIL";
  console.log(
    `[${icon}] ${d.scorer}: ${(d.average * 100).toFixed(1)}% (threshold: ${(d.threshold * 100).toFixed(1)}%)`,
  );
}
console.log("");

if (!passed) {
  console.error("Benchmark thresholds not met.");
  process.exit(1);
}

console.log("All thresholds passed.");
