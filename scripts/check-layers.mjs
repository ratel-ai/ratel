#!/usr/bin/env node
// Layer check for apps/web/lib (ADR-0030): a file in a layer may import its own layer or a lower
// one, never a higher one, and nothing under lib/ may import the UI (`@/components`, `@/app`).
// Usage (from repo root): node scripts/check-layers.mjs [--lib apps/web/lib] [--allow scripts/layers-allow.json]
//
// The allowlist is a ratchet: an entry silences one violation (`<path>:<specifier>`) while the
// copied code is being layered, and an entry that no longer matches anything is itself an error,
// so the list can only shrink. Violations are detected from import specifiers with the same walker
// the ee boundary check uses, so the two checks agree on what an import is.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { collectImports, walk } from "./check-ee-boundary.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

/** Layer folders under lib/ and their level. Lower may not import higher. */
export const LAYERS = Object.freeze({
  contracts: 0,
  adapters: 0,
  composition: 0,
  platform: 1,
  jobs: 1,
  ingest: 2,
  catalog: 2,
  ledger: 3,
  readings: 4,
  synthesis: 5,
  views: 6,
  console: 6,
  mcp: 7,
});

/** Files allowed to import any layer: the composition root that wires every module's register.ts. */
const ROOTS = new Set(["composition/registry.ts"]);

const isTest = (rel) => /\.(test|integration\.test)\.tsx?$/.test(rel) || /\/test-support\.tsx?$/.test(rel);

/** `{ layer, level }` for a path relative to lib/, or null for a file outside every layer folder. */
export function layerOf(relToLib) {
  const top = relToLib.split("/")[0];
  if (top in LAYERS) return { layer: top, level: LAYERS[top] };
  return null;
}

/** Where an import specifier points, relative to lib/: a layer, the UI, or elsewhere. */
export function classifySpecifier(specifier, fromRelToLib) {
  if (specifier.startsWith("@/lib/")) return { kind: "lib", rel: specifier.slice("@/lib/".length) };
  if (specifier === "@/lib") return { kind: "lib", rel: "" };
  if (specifier.startsWith("@/components") || specifier.startsWith("@/app")) return { kind: "ui" };
  if (specifier.startsWith(".")) {
    const target = resolve("/lib", dirname(fromRelToLib), specifier);
    if (target === "/lib" || target.startsWith("/lib/")) return { kind: "lib", rel: relative("/lib", target) };
    if (target.startsWith("/components") || target.startsWith("/app")) return { kind: "ui" };
    return { kind: "outside" };
  }
  return { kind: "external" };
}

export function scanLayers({ libRoot, allow = [] } = {}) {
  const violations = [];
  walk(libRoot, (file) => {
    const rel = relative(libRoot, file).split(sep).join("/");
    if (ROOTS.has(rel)) return;
    const own = layerOf(rel);
    const test = isTest(rel);
    for (const { specifier, line } of collectImports(file)) {
      const target = classifySpecifier(specifier, rel);
      const at = { path: rel, line, specifier };
      if (target.kind === "ui") {
        if (!test) violations.push({ ...at, reason: "lib/ imports the UI" });
        continue;
      }
      if (target.kind !== "lib") continue;
      const dest = layerOf(target.rel);
      if (own == null) {
        violations.push({ ...at, reason: "file is outside every layer" });
        continue;
      }
      if (dest == null) {
        violations.push({ ...at, reason: "imports a file outside every layer" });
        continue;
      }
      if (dest.level > own.level) {
        violations.push({ ...at, reason: `${own.layer} (L${own.level}) imports ${dest.layer} (L${dest.level})` });
      }
    }
  });

  const keyOf = (v) => `${v.path}:${v.specifier}`;
  const allowed = new Set(allow);
  const seen = new Set();
  const remaining = violations.filter((v) => {
    const key = keyOf(v);
    if (allowed.has(key)) {
      seen.add(key);
      return false;
    }
    return true;
  });
  const stale = allow.filter((key) => !seen.has(key));
  return { violations: remaining, stale };
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const libRoot = resolve(REPO_ROOT, arg("--lib", "apps/web/lib"));
  const allowPath = resolve(REPO_ROOT, arg("--allow", "scripts/layers-allow.json"));
  const allow = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, "utf8")) : [];
  const { violations, stale } = scanLayers({ libRoot, allow });
  for (const v of violations) console.error(`${join("apps/web/lib", v.path)}:${v.line}  ${v.reason}  (${v.specifier})`);
  for (const key of stale) console.error(`stale allowlist entry, remove it: ${key}`);
  if (violations.length > 0 || stale.length > 0) process.exit(1);
  console.log(`layers clean: 0 violations${allow.length ? `, ${allow.length} allowed` : ""}`);
}
