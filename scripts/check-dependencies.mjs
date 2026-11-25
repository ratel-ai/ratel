#!/usr/bin/env node
// Every direct dependency of the open-source workspace is approved by name in
// scripts/dependencies-allow.json. A new one is a deliberate line in the pull request that adds
// it. A stale entry fails too, so the list holds only what is used. ee/ keeps its own
// dependencies and is not read.
//
//   node scripts/check-dependencies.mjs [dir]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const ALLOW_FILE = "scripts/dependencies-allow.json";
const FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

function main() {
  const allowed = new Set(readJson(ALLOW_FILE));
  const used = manifests().flatMap((file) => dependencies(file).map((name) => ({ file, name })));
  const names = new Set(used.map(({ name }) => name));
  const problems = [
    ...new Set(
      used
        .filter(({ name }) => !allowed.has(name))
        .map(({ file, name }) => `${file}: ${name} is not in ${ALLOW_FILE}`),
    ),
    ...[...allowed]
      .filter((name) => !names.has(name))
      .map((name) => `${ALLOW_FILE}: ${name} is approved but not used`),
  ];

  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`dependencies clean: ${names.size} approved`);
}

/** The workspace's package.json files, ee/ left out. */
function manifests() {
  const packages = join(ROOT, "packages");
  const folders = existsSync(packages)
    ? readdirSync(packages).map((name) => `packages/${name}`)
    : [];
  return ["", "web", "mcp-apps", ...folders]
    .map((folder) => (folder ? `${folder}/package.json` : "package.json"))
    .filter((file) => existsSync(join(ROOT, file)));
}

function dependencies(file) {
  const manifest = readJson(file);
  return FIELDS.flatMap((field) => Object.entries(manifest[field] ?? {}))
    .filter(([, spec]) => !spec.startsWith("workspace:"))
    .map(([name, spec]) => installedName(name, spec));
}

/** An alias (`npm:other@1`) installs another package than its key says. */
function installedName(name, spec) {
  return /^npm:(@?[^@]+)/.exec(spec)?.[1] ?? name;
}

function readJson(file) {
  return JSON.parse(readFileSync(join(ROOT, file), "utf8"));
}

main();
