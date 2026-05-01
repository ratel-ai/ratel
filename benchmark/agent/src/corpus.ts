import { readFileSync } from "node:fs";
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
  const contents = readFileSync(path, "utf-8");
  return parseScenarios(contents);
}
