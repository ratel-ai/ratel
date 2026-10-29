#!/usr/bin/env node
// Guard against Cloud-only code and confidential names reaching the open-source tree (ADR-0030).
// Two kinds of entry in private-strings.txt, both case-insensitive:
//   - a regular expression: guards the application tree (apps/web), where Cloud-only vendor code
//     would land. Vendor and product names are not secrets; the ADRs name them.
//   - `sha256:<hex>`: a confidential word, stored as a salted hash so the word itself never
//     appears in this repository. A token hashing to the entry fails the check anywhere in the
//     tree, and the sync never lands an upstream path containing it.
//
//   node scripts/platform-sync/private-strings.mjs [dir] [--patterns file] [--code-root dir]
//   node scripts/platform-sync/private-strings.mjs --hash <word>     print the entry to add
//
// `findPrivateStrings(text, patterns)` is pure; `scanDir` walks a tree.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const SALT = "ratel/private-strings/v1";
const TOKEN = /[a-z0-9]+/gi;

/** The list entry for a confidential word: a salted hash of its lowercase form. */
export function hashToken(word) {
  return createHash("sha256").update(`${SALT}:${word.toLowerCase()}`).digest("hex");
}

export function isHashEntry(p) {
  return typeof p === "object" && p !== null && typeof p.hash === "string";
}

/** One entry per non-empty, non-comment line: a RegExp, or `{ hash }` for `sha256:` lines. */
export function loadPatterns(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => (l.startsWith("sha256:") ? { hash: l.slice(7).toLowerCase() } : new RegExp(l, "i")));
}

function matches(line, p) {
  if (!isHashEntry(p)) return p.test(line);
  for (const m of line.matchAll(TOKEN)) if (hashToken(m[0]) === p.hash) return true;
  return false;
}

/** How a hit is reported: the regex source, or a hash prefix that reveals nothing. */
function label(p) {
  return isHashEntry(p) ? `sha256:${p.hash.slice(0, 12)}` : p.source;
}

/** `[{ line, pattern }]` for every line of `text` that matches an entry. */
export function findPrivateStrings(text, patterns) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const p of patterns) if (matches(line, p)) hits.push({ line: i + 1, pattern: label(p) });
  });
  return hits;
}

const TEXT = /\.(c?m?[jt]sx?|json|css|md|mdx|sql|ya?ml|txt|html|rs|py|toml|sh|tf|example)$/;
const SKIP = ["node_modules", ".next", ".git", "target", "dist", "coverage", ".turbo", ".venv", ".claude", "ee"];

/**
 * Scan a tree. Hash entries apply to every text file; regex entries only to files under
 * `codeRoot` (absolute) when it is given, so the docs may name a vendor the code may not.
 */
export function scanDir(dir, patterns, { skip = SKIP, codeRoot = null } = {}) {
  const hits = [];
  const hashesOnly = patterns.filter(isHashEntry);
  const visit = (d) => {
    for (const entry of readdirSync(d)) {
      if (skip.includes(entry)) continue;
      const full = join(d, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (TEXT.test(entry)) {
        const inCode = codeRoot === null || full === codeRoot || full.startsWith(codeRoot + sep);
        for (const h of findPrivateStrings(readFileSync(full, "utf8"), inCode ? patterns : hashesOnly)) {
          hits.push({ path: relative(dir, full), ...h });
        }
      }
    }
  };
  if (existsSync(dir)) visit(dir);
  return hits;
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  if (argv.includes("--hash")) {
    console.log(`sha256:${hashToken(flag("--hash"))}`);
    process.exit(0);
  }
  const positional = argv.filter((a, i) => !a.startsWith("--") && (i === 0 || !argv[i - 1].startsWith("--")));
  const dir = resolve(positional[0] ?? REPO_ROOT);
  const patterns = loadPatterns(resolve(REPO_ROOT, flag("--patterns", "scripts/platform-sync/private-strings.txt")));
  const codeRoot = resolve(REPO_ROOT, flag("--code-root", "apps/web"));
  const hits = scanDir(dir, patterns, { codeRoot });
  for (const h of hits) console.error(`${join(dir, h.path)}:${h.line}  matches ${h.pattern}`);
  if (hits.length > 0) process.exit(1);
  console.log(`no private strings under ${relative(REPO_ROOT, dir) || "."}`);
}
