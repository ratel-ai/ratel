#!/usr/bin/env node
// Inject `optionalDependencies` into src/sdk/ts/package.json based on the
// committed src/sdk/ts/npm/<triple>/package.json files. Each subpackage's
// name + version are the source of truth.
//
// Run this in CI right before `pnpm pack` / `npm publish` for the SDK
// loader. Replaces `napi pre-publish --skip-optional-publish`, which has
// a hidden dependency on git log heuristics that breaks under shallow
// checkouts on non-tagged branches.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SDK_ROOT = "src/sdk/ts";
const MAIN_PKG = join(SDK_ROOT, "package.json");
const NPM_DIR = join(SDK_ROOT, "npm");

const pkg = JSON.parse(readFileSync(MAIN_PKG, "utf8"));
const optionalDependencies = {};

for (const dir of readdirSync(NPM_DIR)) {
  const subPkgPath = join(NPM_DIR, dir, "package.json");
  const sub = JSON.parse(readFileSync(subPkgPath, "utf8"));
  if (sub.version !== pkg.version) {
    throw new Error(
      `version mismatch: ${sub.name}@${sub.version} but loader is ${pkg.version} — bump the subpackage version to match before publishing`,
    );
  }
  optionalDependencies[sub.name] = sub.version;
}

pkg.optionalDependencies = optionalDependencies;
writeFileSync(MAIN_PKG, `${JSON.stringify(pkg, null, 2)}\n`);

console.log(
  `injected ${Object.keys(optionalDependencies).length} optionalDependencies into ${MAIN_PKG} at version ${pkg.version}`,
);
