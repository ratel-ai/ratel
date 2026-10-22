#!/usr/bin/env node
// Mechanical import-boundary check for the commercial modules in ee/.
// Usage (from repo root): node scripts/check-ee-boundary.mjs
//
// Two rules, one directory name:
//   inward  — nothing outside ee/ imports from ee/, except the enumerated route stubs,
//             which exist only because Next.js defines routes by file position.
//   outward — ee/ reaches the application tree only through lib/contracts/.
//
// It reads import specifiers, so it cannot see a build alias that points into ee/.
// The seam (#ee-composition) is exactly such an alias: a companion check on the alias
// set belongs with this one before it guards anything in CI.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const EE_ROOT = join(REPO_ROOT, "ee");
const SCAN_ROOTS = [join(REPO_ROOT, "apps", "web"), EE_ROOT];

// Exact paths, not a pattern: each exception is a deliberate, reviewable entry.
const ALLOWED_INWARD = new Set([join(REPO_ROOT, "apps", "web", "app", "(ee)", "admin", "page.tsx")]);

const IMPORT_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']\s*\)/g;

function walk(dir, visit) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, visit);
    else if (/\.tsx?$/.test(entry)) visit(full);
  }
}

const isInsideEe = (file) => file === EE_ROOT || file.startsWith(EE_ROOT + sep);

function pointsIntoEe(fromFile, specifier) {
  if (specifier === "@ee" || specifier.startsWith("@ee/")) return true;
  if (!specifier.startsWith(".")) return false;
  return isInsideEe(resolve(dirname(fromFile), specifier));
}

export function scanEeBoundary() {
  const violations = [];

  for (const root of SCAN_ROOTS) {
    walk(root, (file) => {
      const rel = relative(REPO_ROOT, file);
      const insideEe = isInsideEe(file);
      const lines = readFileSync(file, "utf8").split(/\r?\n/);

      lines.forEach((line, i) => {
        IMPORT_RE.lastIndex = 0;
        let match;
        while ((match = IMPORT_RE.exec(line)) !== null) {
          const specifier = match[1] ?? match[2];
          if (specifier == null) continue;
          const at = { path: rel, line: i + 1 };

          if (!insideEe) {
            if (pointsIntoEe(file, specifier) && !ALLOWED_INWARD.has(file)) {
              violations.push({ ...at, reason: `inward import of ee/ via ${JSON.stringify(specifier)}` });
            }
            continue;
          }

          // Inside ee/: contracts, itself, and npm packages only.
          if (specifier === "@/lib/contracts" || specifier.startsWith("@/lib/contracts/")) continue;
          if (pointsIntoEe(file, specifier)) continue;
          if (specifier.startsWith("@/")) {
            violations.push({ ...at, reason: `outward import of core via ${JSON.stringify(specifier)}` });
          } else if (specifier.startsWith(".")) {
            violations.push({ ...at, reason: `outward relative import of core via ${JSON.stringify(specifier)}` });
          }
        }
      });
    });
  }

  return violations;
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = scanEeBoundary();
  for (const v of violations) console.error(`${v.path}:${v.line}  ${v.reason}`);
  if (violations.length > 0) process.exit(1);
  console.log("ee boundary clean: 0 violations");
}
