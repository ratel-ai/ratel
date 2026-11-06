#!/usr/bin/env node
// Copies the open-source parts of ratel-cloud into this tree (ADR-0030), repeatably.
//
//   node scripts/platform-sync/sync.mjs [--source ../ratel-cloud] [--only apps/web/lib/ingest] [--check] [--no-format]
//
// `map.json` lists what moves where: `copy` entries are mirrored from the source (added, updated,
// deleted) with every import specifier rewritten through `rewrites.json`; `owned` entries are
// maintained here and never overwritten (the report prints their upstream diff since the last
// recorded sync); `excluded` entries never land. Every landed file is checked against
// `private-strings.txt`; one hit fails the run before anything is written. `--check` writes
// nothing and exits 1 when a sync would change the tree. `source.json` records the commit synced.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findPrivateStrings, isHashEntry, loadPatterns } from "./private-strings.mjs";
import { buildRules, rewriteSource } from "./rewrite-imports.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const CODE = /\.(m?[jt]sx?)$/;

const posix = (p) => p.split(sep).join("/");

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

const under = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

/** Destination -> source for one entry; a file entry maps itself, a directory entry maps its files. */
function expand(entry, sourceRoot) {
  const from = join(sourceRoot, entry.from);
  if (!existsSync(from)) return [];
  if (statSync(from).isFile()) return [{ from: entry.from, to: entry.to }];
  return walkFiles(from).map((f) => {
    const rel = posix(relative(from, f));
    return { from: `${entry.from}/${rel}`, to: `${entry.to}/${rel}` };
  });
}

/**
 * The biome override for copied code, in map order: a copied file as itself, a copied folder as a
 * glob followed by the owned files inside it, negated. `[` and `]` are escaped for biome.
 */
export function copyIncludes(map, repoRoot = REPO_ROOT) {
  const glob = (p) => p.replace(/[[\]]/g, "\\$&");
  const owned = map.entries.filter((e) => e.mode === "owned").map((e) => e.to);
  return map.entries
    .filter((e) => e.mode === "copy")
    .flatMap((e) => {
      const dest = join(repoRoot, e.to);
      if (!existsSync(dest) || !statSync(dest).isDirectory()) return [glob(e.to)];
      return [`${glob(e.to)}/**`, ...owned.filter((o) => under(o, e.to)).map((o) => `!${glob(o)}`)];
    });
}

/**
 * Format planned files the way the repository's biome would, in one run, so a plan compares like
 * with like. The files are staged under a temporary mirror of the tree beside a copy of
 * `biome.json`, so the path-based overrides (the copied-code one among them) apply as they do in
 * the tree. One process for the whole plan: a process per file (`--stdin-file-path`) cost about
 * half a second each, minutes for a full sync, which is what the per-folder checks timed out on.
 * `check --write` applies the safe fixes (import sorting) as well as formatting, which is what a
 * committed file has been through; it exits 1 when a file keeps a lint error it cannot fix, and
 * the fixes it could make are written all the same.
 */
export function formatAllWithBiome(repoRoot, files) {
  if (files.size === 0) return files;
  const stage = mkdtempSync(join(tmpdir(), "platform-sync-format-"));
  try {
    const config = JSON.parse(readFileSync(join(repoRoot, "biome.json"), "utf8"));
    writeFileSync(join(stage, "biome.json"), JSON.stringify({ ...config, vcs: { enabled: false } }));
    for (const [to, content] of files) {
      mkdirSync(dirname(join(stage, to)), { recursive: true });
      writeFileSync(join(stage, to), content);
    }
    try {
      execFileSync("pnpm", ["exec", "biome", "check", "--write", "--config-path", stage, stage], {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {}
    const out = new Map();
    for (const to of files.keys()) out.set(to, readFileSync(join(stage, to)));
    return out;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * Plan a sync without touching the tree. Returns the actions and the report; `apply` writes them.
 * With `format`, code is formatted before comparison, so a tree biome already formatted is in sync;
 * `formatter` is the batch formatter, injectable for tests.
 */
export function planSync({
  sourceRoot,
  repoRoot = REPO_ROOT,
  map,
  rewrites,
  patterns = [],
  only = null,
  format = false,
  formatter = formatAllWithBiome,
}) {
  const entries = map.entries.filter((e) => !only || under(e.to ?? e.from, only) || under(e.from, only));
  const excluded = map.entries.filter((e) => e.mode === "excluded").map((e) => e.from);
  const ownedByTo = new Map(map.entries.filter((e) => e.mode === "owned").map((e) => [e.to, e]));
  const codemod = {
    rules: buildRules(map, rewrites),
    partitions: rewrites?.partitions ?? {},
    identifiers: rewrites?.identifiers ?? {},
    brand: rewrites?.brand,
    entries: map.entries,
  };

  const writes = new Map(); // to -> { from, content }
  const report = { copied: [], updated: [], deleted: [], ownedBootstrapped: [], ownedKept: [], unmapped: [], privateHits: [], privatePathsSkipped: 0 };
  const confidential = patterns.filter(isHashEntry);

  const land = (pair, owned) => {
    if (excluded.some((x) => under(pair.from, x))) return;
    // An upstream path naming confidential data is excluded implicitly, so the map never has to spell it.
    if (findPrivateStrings(pair.from, confidential).length > 0) {
      report.privatePathsSkipped++;
      return;
    }
    if (!owned && ownedByTo.has(pair.to)) return; // an owned file inside a copied folder stays ours
    const src = join(sourceRoot, pair.from);
    let content = readFileSync(src);
    if (CODE.test(pair.from)) {
      const { code, unmapped } = rewriteSource(content.toString("utf8"), codemod, pair.from);
      content = Buffer.from(code, "utf8");
      for (const u of unmapped) report.unmapped.push({ path: pair.to, specifier: u });
    }
    writes.set(pair.to, { from: pair.from, content });
  };

  // The most specific entry wins: a folder entry skips a file that has an entry of its own.
  const ownEntry = new Set(map.entries.filter((e) => e.mode !== "excluded").map((e) => e.from));
  for (const entry of entries) {
    if (entry.mode === "excluded") continue;
    for (const pair of expand(entry, sourceRoot)) {
      if (pair.from !== entry.from && ownEntry.has(pair.from)) continue;
      if (entry.mode === "owned") {
        if (existsSync(join(repoRoot, pair.to))) report.ownedKept.push(pair.to);
        else land(pair, true);
        continue;
      }
      land(pair, false);
    }
  }

  // Formatted in one run, then guarded: a private string is looked for in what would land.
  if (format) {
    const code = new Map([...writes].filter(([to]) => CODE.test(to)).map(([to, w]) => [to, w.content]));
    for (const [to, content] of formatter(repoRoot, code)) writes.get(to).content = content;
  }
  for (const [to, w] of writes) {
    for (const h of findPrivateStrings(w.content.toString("utf8"), patterns)) {
      report.privateHits.push({ path: to, from: w.from, ...h });
    }
    if (findPrivateStrings(to, patterns).length) report.privateHits.push({ path: to, from: w.from, line: 0, pattern: "path" });
  }

  // Mirror: a file under a copied directory that the source no longer has is deleted here.
  const deletes = [];
  for (const entry of entries) {
    if (entry.mode !== "copy") continue;
    const destDir = join(repoRoot, entry.to);
    if (!existsSync(destDir) || !statSync(destDir).isDirectory()) continue;
    for (const f of walkFiles(destDir)) {
      const to = posix(relative(repoRoot, f));
      if (!writes.has(to) && !ownedByTo.has(to)) deletes.push(to);
    }
  }

  const actions = [];
  for (const [to, w] of writes) {
    const dest = join(repoRoot, to);
    const exists = existsSync(dest);
    if (exists && readFileSync(dest).equals(w.content)) continue;
    actions.push({ kind: "write", to, content: w.content });
    const owned = ownedByTo.has(to);
    (owned ? report.ownedBootstrapped : exists ? report.updated : report.copied).push(to);
  }
  for (const to of deletes) {
    actions.push({ kind: "delete", to });
    report.deleted.push(to);
  }
  return { actions, report };
}

export function applySync(actions, { repoRoot = REPO_ROOT } = {}) {
  for (const a of actions) {
    const dest = join(repoRoot, a.to);
    if (a.kind === "delete") rmSync(dest, { force: true });
    else {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, a.content);
    }
  }
}

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Upstream changes to owned sources since the recorded commit, for a human to port by hand. */
export function ownedDrift({ sourceRoot, map, sinceCommit }) {
  if (!sinceCommit) return "";
  const paths = map.entries.filter((e) => e.mode === "owned").map((e) => e.from);
  if (paths.length === 0) return "";
  return git(sourceRoot, ["diff", "--stat", `${sinceCommit}..HEAD`, "--", ...paths]) ?? "";
}

function printReport(report, drift) {
  const list = (title, items) => {
    if (items.length === 0) return;
    console.log(`\n${title} (${items.length})`);
    for (const i of items) console.log(`  ${typeof i === "string" ? i : JSON.stringify(i)}`);
  };
  list("copied", report.copied);
  list("updated", report.updated);
  list("deleted", report.deleted);
  list("owned, bootstrapped from upstream (now yours to maintain)", report.ownedBootstrapped);
  list("unmapped @/lib specifiers (add a map or rewrite rule)", report.unmapped);
  list("PRIVATE STRING HITS (nothing written)", report.privateHits);
  if (report.privatePathsSkipped > 0) console.log(`skipped ${report.privatePathsSkipped} upstream path(s) naming confidential data`);
  if (drift) console.log(`\nowned files changed upstream since the last sync; port by hand:\n${drift}`);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceRoot = resolve(REPO_ROOT, arg("--source", process.env.RATEL_CLOUD_DIR || "../ratel-cloud"));
  // An empty or missing source would plan every copied file as a deletion.
  if (!existsSync(join(sourceRoot, "apps/web/package.json"))) {
    console.error(`${sourceRoot} is not a ratel-cloud checkout; pass --source <path> or set RATEL_CLOUD_DIR`);
    process.exit(1);
  }
  const only = arg("--only", null);
  const check = process.argv.includes("--check");
  const format = !process.argv.includes("--no-format");
  const map = JSON.parse(readFileSync(join(SCRIPT_DIR, "map.json"), "utf8"));
  const rewrites = JSON.parse(readFileSync(join(SCRIPT_DIR, "rewrites.json"), "utf8"));
  const patterns = loadPatterns(join(SCRIPT_DIR, "private-strings.txt"));
  const sourcePath = join(SCRIPT_DIR, "source.json");
  const source = existsSync(sourcePath) ? JSON.parse(readFileSync(sourcePath, "utf8")) : {};

  const { actions, report } = planSync({ sourceRoot, map, rewrites, patterns, only, format });
  const drift = ownedDrift({ sourceRoot, map, sinceCommit: source.commit });
  printReport(report, drift);
  if (report.privateHits.length > 0) process.exit(1);
  if (check) {
    if (actions.length > 0) {
      console.error(`\n${actions.length} change(s) pending; run without --check to apply`);
      process.exit(1);
    }
    console.log("\nin sync");
    process.exit(0);
  }
  applySync(actions);
  const commit = git(sourceRoot, ["rev-parse", "HEAD"]);
  if (commit && !only) {
    writeFileSync(sourcePath, `${JSON.stringify({ ...source, commit, syncedAt: new Date().toISOString().slice(0, 10) }, null, 2)}\n`);
  }
  console.log(`\napplied ${actions.length} change(s)${commit ? ` from ${commit.slice(0, 8)}` : ""}`);
}
