import { existsSync, readFileSync } from "node:fs";
import type { Scenario } from "./types.js";

export function parseScenarios(jsonl: string): Scenario[] {
  const out: Scenario[] = [];
  const lines = jsonl.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as Scenario);
    } catch (err) {
      throw new Error(`failed to parse scenario at line ${i + 1}: ${(err as Error).message}`);
    }
  }
  return out;
}

export function loadScenarios(path: string): Scenario[] {
  if (!existsSync(path)) {
    throw new Error(
      `corpus not found at ${path}. Run \`pnpm -F @ratel-ai/benchmark run-all\` ` +
        `to ingest + run end-to-end, or \`cargo run -p ratel-benchmark-retrieval --release ` +
        `-- ingest metatool --download\` to ingest only.`,
    );
  }
  const contents = readFileSync(path, "utf-8");
  return parseScenarios(contents);
}
