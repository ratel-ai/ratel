#!/usr/bin/env node
// Guard against Cloud-only code and customer data reaching the open-source tree (ADR-0030).
// `findPrivateStrings(text, patterns)` is pure; the CLI scans a directory of text files:
//   node scripts/platform-sync/private-strings.mjs <dir> [--patterns scripts/platform-sync/private-strings.txt]

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");

/** One regex per non-empty, non-comment line; `\b` word bounds are the file author's choice. */
export function loadPatterns(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => new RegExp(l, "i"));
}

/** `[{ line, pattern }]` for every line of `text` that matches a pattern. */
export function findPrivateStrings(text, patterns) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const p of patterns) if (p.test(line)) hits.push({ line: i + 1, pattern: p.source });
  });
  return hits;
}

const TEXT = /\.(m?[jt]sx?|json|css|md|mdx|sql|ya?ml|txt|html)$/;

export function scanDir(dir, patterns, { skip = ["node_modules", ".next", ".git"] } = {}) {
  const hits = [];
  const visit = (d) => {
    for (const entry of readdirSync(d)) {
      if (skip.includes(entry)) continue;
      const full = join(d, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (TEXT.test(entry)) {
        for (const h of findPrivateStrings(readFileSync(full, "utf8"), patterns)) {
          hits.push({ path: relative(dir, full), ...h });
        }
      }
    }
  };
  if (existsSync(dir)) visit(dir);
  return hits;
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? "apps/web");
  const i = process.argv.indexOf("--patterns");
  const patternsPath = resolve(REPO_ROOT, i >= 0 ? process.argv[i + 1] : "scripts/platform-sync/private-strings.txt");
  const hits = scanDir(dir, loadPatterns(patternsPath));
  for (const h of hits) console.error(`${join(dir, h.path)}:${h.line}  matches /${h.pattern}/`);
  if (hits.length > 0) process.exit(1);
  console.log(`no private strings under ${relative(REPO_ROOT, dir) || "."}`);
}
