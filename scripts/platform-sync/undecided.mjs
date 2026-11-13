#!/usr/bin/env node
// Lists the ratel-cloud files that have no decision in map.json (ADR-0030). A local tool: it reads
// the file list of the synced commit (source.json) from the ratel-cloud repository's history, so it
// answers the same whatever that checkout has checked out, and it writes nothing anywhere.
//
//   node scripts/platform-sync/undecided.mjs [--source ../ratel-cloud]
//
// A file is decided by the most specific map entry that covers it (`copy`, `owned` or `excluded`).
// A file whose path names confidential data is decided too: the sync excludes it implicitly, since
// the map cannot spell the path. Those are counted, never printed. Exits 1 if a file is undecided.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findPrivateStrings, isHashEntry, loadPatterns } from "./private-strings.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const ROOTS = ["apps/web", "packages"];

const under = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * How many upstream `paths` each mode decides, how many the confidential-path guard decides, and
 * the paths nothing decides. `patterns` is the private-strings list; only its hash entries apply.
 */
export function classifyUpstream(paths, map, patterns = []) {
  const confidential = patterns.filter(isHashEntry);
  const result = { copy: 0, owned: 0, excluded: 0, confidential: 0, undecided: [] };
  for (const path of paths) {
    if (findPrivateStrings(path, confidential).length > 0) {
      result.confidential++;
      continue;
    }
    let entry = null;
    for (const e of map.entries) {
      if (under(path, e.from) && (entry === null || e.from.length > entry.from.length)) entry = e;
    }
    if (entry === null) result.undecided.push(path);
    else result[entry.mode]++;
  }
  return result;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceRoot = resolve(REPO_ROOT, arg("--source", process.env.RATEL_CLOUD_DIR || "../ratel-cloud"));
  if (!existsSync(join(sourceRoot, "apps/web/package.json"))) {
    console.error(`${sourceRoot} is not a ratel-cloud checkout; pass --source <path> or set RATEL_CLOUD_DIR`);
    process.exit(1);
  }
  const { commit } = JSON.parse(readFileSync(join(SCRIPT_DIR, "source.json"), "utf8"));
  let listing;
  try {
    listing = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", commit, "--", ...ROOTS], {
      cwd: sourceRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    console.error(`${sourceRoot} does not have the synced commit ${commit.slice(0, 8)}; fetch it there first`);
    process.exit(1);
  }
  const paths = listing.split("\0").filter(Boolean);
  const map = JSON.parse(readFileSync(join(SCRIPT_DIR, "map.json"), "utf8"));
  const patterns = loadPatterns(join(SCRIPT_DIR, "private-strings.txt"));
  const result = classifyUpstream(paths, map, patterns);

  console.log(`${paths.length} upstream files at ${commit.slice(0, 8)}`);
  console.log(`  copy ${result.copy}, owned ${result.owned}, excluded ${result.excluded}`);
  console.log(`  skipped as confidential ${result.confidential} (paths not printed)`);
  if (result.undecided.length === 0) {
    console.log("\nevery file has a decision");
    process.exit(0);
  }
  const folders = new Map();
  for (const path of result.undecided) {
    const folder = dirname(path);
    folders.set(folder, [...(folders.get(folder) ?? []), path]);
  }
  console.log(`\nundecided (${result.undecided.length}); add an entry to map.json`);
  for (const [folder, files] of folders) {
    console.log(`\n${folder} (${files.length})`);
    for (const f of files) console.log(`  ${f}`);
  }
  process.exit(1);
}
