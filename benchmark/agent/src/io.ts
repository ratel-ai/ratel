// Shared JSONL helpers. The runner has its own `appendRow` because it needs
// the synchronous append guarantees described in `runner.ts:218`; everything
// else (report-cli, rejudge) uses these.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split("\n");
  const out: T[] = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    out.push(JSON.parse(l) as T);
  }
  return out;
}

export function appendJsonl<T>(path: string, row: T): void {
  appendFileSync(path, `${JSON.stringify(row)}\n`, "utf-8");
}

/** Truncate the file (or create it empty) before a streaming run starts. */
export function truncateJsonl(path: string): void {
  writeFileSync(path, "", "utf-8");
}
