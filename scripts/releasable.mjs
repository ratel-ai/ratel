#!/usr/bin/env node
// "Which release units have unreleased commits?" (ADR-0016 DX helper).
//
// For each unit in the shared registry (release-units.mjs) it finds the unit's
// last release tag (`<prefix>*`) and counts commits touching that unit's paths
// since then — so before cutting a release you can see, at a glance, exactly
// which registered unit (core / sdk-js / sdk-py / telemetry / …) actually
// changed and by how much. The unit list comes from the registry, not this comment.
//
// Usage (from repo root):
//   node scripts/releasable.mjs           # table
//   node scripts/releasable.mjs --json     # machine-readable
//
// Informational only: always exits 0.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { UNITS } from "./release-units.mjs";

// Pure core: given a unit registry and injectable git accessors, decide which
// units are releasable. `git.lastTag(prefix)` returns the unit's most recent tag
// (or null if it has never shipped); `git.countCommits(sinceTagOrNull, paths)`
// returns the number of commits since that tag (all of history when null).
export function computeReleasable(units, git) {
  return Object.entries(units).map(([unit, spec]) => {
    const lastTag = git.lastTag(spec.tagPrefix);
    const commits = git.countCommits(lastTag, spec.srcPaths);
    return { unit, tagPrefix: spec.tagPrefix, lastTag, commits, releasable: commits > 0 };
  });
}

export function formatTable(rows) {
  const header = ["UNIT", "LAST TAG", "COMMITS", "RELEASABLE"];
  const body = rows.map((r) => [
    r.unit,
    r.lastTag ?? "(never released)",
    String(r.commits),
    r.releasable ? "yes" : "—",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(header), ...body.map(line)].join("\n");
}

// ---- real git wiring ----
function run(args, { quiet = false } = {}) {
  // quiet: swallow git's stderr for calls where "no match" is an expected,
  // non-error outcome (a unit that has simply never been released).
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", quiet ? "ignore" : "inherit"],
  }).trim();
}

const git = {
  // Most recent tag matching `<prefix>*` reachable from HEAD, or null if the
  // unit has never been released. `describe --abbrev=0` gives the last tag in
  // history (not the highest version string), which is what "since the last
  // release" means when rc and GA tags interleave.
  lastTag(prefix) {
    try {
      return run(["describe", "--tags", "--abbrev=0", "--match", `${prefix}*`, "HEAD"], { quiet: true }) || null;
    } catch {
      return null;
    }
  },
  countCommits(sinceTag, paths) {
    const range = sinceTag ? `${sinceTag}..HEAD` : "HEAD";
    const out = run(["rev-list", "--count", range, "--", ...paths]);
    return Number.parseInt(out, 10) || 0;
  },
};

function main(argv) {
  const rows = computeReleasable(UNITS, git);
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatTable(rows)}\n`);
  const ready = rows.filter((r) => r.releasable).map((r) => r.unit);
  process.stdout.write(
    ready.length
      ? `\n${ready.length} unit(s) with unreleased commits: ${ready.join(", ")}\n`
      : "\nNo units have commits since their last release tag.\n",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
