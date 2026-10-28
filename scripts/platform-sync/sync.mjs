#!/usr/bin/env node
// Copies the open-source parts of ratel-cloud into this tree (ADR-0030), repeatably.
//
//   node scripts/platform-sync/sync.mjs --source ../ratel-cloud [--only apps/web/lib/ingest] [--check] [--no-format]
//
// `map.json` lists what moves where: `copy` entries are mirrored from the source (added, updated,
// deleted) with every import specifier rewritten through `rewrites.json`; `owned` entries are
// maintained here and never overwritten (the report prints their upstream diff since the last
// recorded sync); `excluded` entries never land. Every landed file is checked against
// `private-strings.txt`; one hit fails the run before anything is written. `--check` writes
// nothing and exits 1 when a sync would change the tree. `source.json` records the commit synced.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findPrivateStrings, loadPatterns } from "./private-strings.mjs";
import { buildRules, rewriteSpecifiers } from "./rewrite-imports.mjs";

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
 * Plan a sync without touching the tree. Returns the actions and the report; `apply` writes them.
 */
export function planSync({ sourceRoot, repoRoot = REPO_ROOT, map, rewrites, patterns = [], only = null }) {
  const entries = map.entries.filter((e) => !only || under(e.to ?? e.from, only) || under(e.from, only));
  const excluded = map.entries.filter((e) => e.mode === "excluded").map((e) => e.from);
  const ownedByTo = new Map(map.entries.filter((e) => e.mode === "owned").map((e) => [e.to, e]));
  const rules = buildRules(map, rewrites);

  const writes = new Map(); // to -> { from, content }
  const report = { copied: [], updated: [], deleted: [], ownedBootstrapped: [], ownedKept: [], unmapped: [], privateHits: [] };

  const land = (pair, owned) => {
    if (excluded.some((x) => under(pair.from, x))) return;
    if (!owned && ownedByTo.has(pair.to)) return; // an owned file inside a copied folder stays ours
    const src = join(sourceRoot, pair.from);
    let content = readFileSync(src);
    if (CODE.test(pair.from)) {
      const { code, unmapped } = rewriteSpecifiers(content.toString("utf8"), rules);
      content = Buffer.from(code, "utf8");
      for (const u of unmapped) report.unmapped.push({ path: pair.to, specifier: u });
    }
    for (const h of findPrivateStrings(content.toString("utf8"), patterns)) {
      report.privateHits.push({ path: pair.to, from: pair.from, ...h });
    }
    if (findPrivateStrings(pair.to, patterns).length) report.privateHits.push({ path: pair.to, from: pair.from, line: 0, pattern: "path" });
    writes.set(pair.to, { from: pair.from, content });
  };

  for (const entry of entries) {
    if (entry.mode === "excluded") continue;
    for (const pair of expand(entry, sourceRoot)) {
      if (entry.mode === "owned") {
        if (existsSync(join(repoRoot, pair.to))) report.ownedKept.push(pair.to);
        else land(pair, true);
        continue;
      }
      land(pair, false);
    }
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

function formatFiles(repoRoot, files) {
  if (files.length === 0) return;
  execFileSync("pnpm", ["exec", "biome", "check", "--write", "--no-errors-on-unmatched", ...files], {
    cwd: repoRoot,
    stdio: "inherit",
  });
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
  if (drift) console.log(`\nowned files changed upstream since the last sync; port by hand:\n${drift}`);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceRoot = resolve(REPO_ROOT, arg("--source", "../ratel-cloud"));
  const only = arg("--only", null);
  const check = process.argv.includes("--check");
  const format = !process.argv.includes("--no-format");
  const map = JSON.parse(readFileSync(join(SCRIPT_DIR, "map.json"), "utf8"));
  const rewrites = JSON.parse(readFileSync(join(SCRIPT_DIR, "rewrites.json"), "utf8"));
  const patterns = loadPatterns(join(SCRIPT_DIR, "private-strings.txt"));
  const sourcePath = join(SCRIPT_DIR, "source.json");
  const source = existsSync(sourcePath) ? JSON.parse(readFileSync(sourcePath, "utf8")) : {};

  const { actions, report } = planSync({ sourceRoot, map, rewrites, patterns, only });
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
  if (format) formatFiles(REPO_ROOT, actions.filter((a) => a.kind === "write" && CODE.test(a.to)).map((a) => a.to));
  const commit = git(sourceRoot, ["rev-parse", "HEAD"]);
  if (commit && !only) {
    writeFileSync(sourcePath, `${JSON.stringify({ ...source, commit, syncedAt: new Date().toISOString().slice(0, 10) }, null, 2)}\n`);
  }
  console.log(`\napplied ${actions.length} change(s)${commit ? ` from ${commit.slice(0, 8)}` : ""}`);
}
