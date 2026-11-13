import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

/**
 * RC-214: every read of a big telemetry table names a project, so no query
 * can scan every tenant's rows (the October match-quality sweep read all of
 * trace_events every minute). A deliberate cross-project query (a retention
 * batch) says so with a `// cross-project: <why>` comment right above it.
 *
 * A source check, so it is a net, not a proof: it looks for a project filter
 * in the statement around each `.from(<table>)` or `from <table>`.
 */

const ROOTS = ["lib", "app"];
const TABLE_READ =
  /\.from\((traceEvents|otelSpans|otelLogs|events)\)|from (trace_events|otel_spans|otel_logs)\b/g;
const PROJECT_FILTER = /project_?id|projectId/i;
const MARKER = "// cross-project:";
/** How far around a match the statement is looked for. */
const BEFORE = 600;
const AFTER = 1500;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory())
      return name === "node_modules" || name === "seed" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

test("every telemetry table read names a project, or says why it reads them all", () => {
  const unscoped: string[] = [];
  let reads = 0;
  for (const file of ROOTS.flatMap((root) => sourceFiles(root))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(TABLE_READ)) {
      reads += 1;
      const around = source.slice(Math.max(0, match.index - BEFORE), match.index + AFTER);
      if (PROJECT_FILTER.test(around) || around.includes(MARKER)) continue;
      unscoped.push(`${file}:${source.slice(0, match.index).split("\n").length} ${match[0]}`);
    }
  }
  assert.ok(reads > 50, "the check still finds the telemetry reads");
  assert.deepEqual(
    unscoped,
    [],
    "add a project filter, or a `// cross-project: <why>` comment above the query",
  );
});
