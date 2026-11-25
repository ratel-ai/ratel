#!/usr/bin/env node
// Path classifier for the pre-merge CI legs. The `changes` job feeds the pull
// request file list here; each boolean output gates one or more jobs in ci.yml.
//
// Globs are relative to the repository root. Platform and design-system rules
// name packages/brand and packages/design-system; they never use packages/**.

import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const OUTPUTS = ["design_system", "platform", "compose", "deploy", "lockfiles"];

/** Doc allowlist: these paths set no output. */
const DOC_ALLOW = [
  "**/*.md",
  "docs/**",
  "LICENSE",
  "LICENSE.*",
  ".gitignore",
  ".gitattributes",
];

/**
 * Owner of each path under scripts/. A change to an owned path sets that
 * owner's output (or every output for "all"). Tests for an owner run only in
 * that owner's job. The "changes" owner sets no extra output: those tests run
 * in the changes job itself.
 */
export const SCRIPT_OWNERS = {
  "scripts/check-layers.mjs": "platform",
  "scripts/check-layers.test.mjs": "platform",
  "scripts/layers-allow.json": "platform",
  "scripts/check-ee-boundary.mjs": "platform",
  "scripts/link-ee.mjs": "platform",
  "scripts/link-ee.test.mjs": "platform",
  "scripts/check-dependencies.mjs": "platform",
  "scripts/check-dependencies.test.mjs": "platform",
  "scripts/dependencies-allow.json": "platform",
  "scripts/quick-start.test.mjs": "platform",
  "scripts/install.test.mjs": "platform",
  "scripts/deploy.test.mjs": "platform",
  "scripts/deploy-buttons.mjs": "platform",
  "scripts/deploy-buttons.test.mjs": "platform",

  "scripts/workflow-contracts.test.mjs": "changes",
  "scripts/ci-filters.mjs": "changes",
  "scripts/ci-filters.test.mjs": "changes",

  "scripts/setup-branch-ruleset.sh": "all",
};

/** Package directory -> package.json name, for the workspace-dependency contract. */
export const PACKAGE_DIRS = {
  web: "@ratel/platform",
  "mcp-apps": "@ratel/mcp-apps",
  "packages/brand": "@ratel/brand",
  "packages/design-system": "@ratel/design-system",
  ee: "@ratel/ee",
};

/**
 * Outputs that validate a package. Used by the workspace-dependency contract:
 * a dependency's directory must select every validate-output of each package
 * that workspace-depends on it. Broader path triggers (for example brand also
 * starting platform) live in classify(), not here.
 */
export const PACKAGE_OUTPUTS = {
  web: ["platform", "compose"],
  "mcp-apps": ["platform", "compose"],
  "packages/brand": ["design_system"],
  "packages/design-system": ["design_system"],
  ee: ["platform"],
};

const ALL_TRUE = Object.fromEntries(OUTPUTS.map((k) => [k, true]));
const ALL_FALSE = Object.fromEntries(OUTPUTS.map((k) => [k, false]));

function globToRegExp(glob) {
  let i = 0;
  let out = "^";
  while (i < glob.length) {
    if (glob.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
      continue;
    }
    if (glob.startsWith("**", i)) {
      out += ".*";
      i += 2;
      continue;
    }
    if (glob[i] === "*") {
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (glob[i] === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    const ch = glob[i];
    if (/[.+^${}()|[\]\\]/.test(ch)) out += `\\${ch}`;
    else out += ch;
    i += 1;
  }
  out += "$";
  return new RegExp(out);
}

const compiled = new Map();
function matches(glob, file) {
  let re = compiled.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    compiled.set(glob, re);
  }
  return re.test(file);
}

function anyMatch(globs, file) {
  return globs.some((g) => matches(g, file));
}

function emptyResult() {
  return { ...ALL_FALSE };
}

function merge(into, keys) {
  for (const k of keys) into[k] = true;
  return into;
}

function setAll(into) {
  for (const k of OUTPUTS) into[k] = true;
  return into;
}

/**
 * Classify a list of changed paths (posix, relative to the repo root).
 * Returns a boolean map keyed by OUTPUTS.
 */
export function classify(files) {
  const result = emptyResult();
  if (!files || files.length === 0) return result;

  let sawClaimed = false;
  let sawUnclaimed = false;

  for (const raw of files) {
    const file = raw.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!file || file.endsWith("/")) continue;

    if (anyMatch(DOC_ALLOW, file) && !file.startsWith("scripts/")) {
      // Doc-only: no output.
      continue;
    }

    const before = OUTPUTS.filter((k) => result[k]).length;
    applyFile(result, file);
    const after = OUTPUTS.filter((k) => result[k]).length;

    if (after > before || OUTPUTS.every((k) => result[k])) {
      sawClaimed = true;
    }

    // Unclaimed: applyFile set every output via the catch-all.
    if (isUnclaimed(file)) {
      sawUnclaimed = true;
      setAll(result);
    }
  }

  // Silence unused — the flags document the scan. A pure-doc PR leaves result all-false.
  void sawClaimed;
  void sawUnclaimed;
  return result;
}

function isDocOnly(file) {
  return anyMatch(DOC_ALLOW, file) && !file.startsWith("scripts/");
}

function isUnclaimed(file) {
  if (isDocOnly(file)) return false;
  if (file.startsWith("scripts/")) {
    return SCRIPT_OWNERS[file] === undefined;
  }
  return !CLAIMS.some((g) => matches(g, file));
}

/** Every glob that claims a path (so the catch-all can detect unknowns). */
const CLAIMS = [
  ".github/workflows/ci.yml",
  "scripts/setup-branch-ruleset.sh",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package.json",
  "biome.json",
  ".github/dependabot.yml",
  ".trivyignore.yaml",
  "web/**",
  "mcp-apps/**",
  "packages/brand/**",
  "packages/design-system/**",
  "ee/**",
  "docker-compose.yml",
  ".env.example",
  ".dockerignore",
  "web/Dockerfile",
  "install.sh",
  "docker-compose.caddy.yml",
  "docker-compose.build.yml",
  "deploy.sh",
  "deploy/**",
  ...Object.keys(SCRIPT_OWNERS),
];

function applyFile(result, file) {
  if (file === ".github/workflows/ci.yml" || file === "scripts/setup-branch-ruleset.sh") {
    return setAll(result);
  }

  if (file.startsWith("scripts/")) {
    const owner = SCRIPT_OWNERS[file];
    if (owner === "all") return setAll(result);
    if (owner === "changes") return result;
    if (owner === "platform") {
      merge(result, ["platform"]);
      if (file.startsWith("scripts/deploy")) merge(result, ["deploy"]);
      if (file === "scripts/link-ee.mjs") merge(result, ["compose"]);
      return result;
    }
    // Unowned script: fall through to setAll via isUnclaimed.
    return setAll(result);
  }

  // Lockfile scan: the lockfiles themselves and the exceptions file.
  if (file === "pnpm-lock.yaml" || file === ".trivyignore.yaml") {
    merge(result, ["lockfiles"]);
  }

  // Dependabot config: a bot setting, no leg to run.
  if (file === ".github/dependabot.yml") return result;

  if (
    file === "pnpm-lock.yaml" ||
    file === "pnpm-workspace.yaml" ||
    file === "package.json"
  ) {
    return merge(result, ["design_system", "platform", "compose"]);
  }

  if (file === "biome.json") {
    return merge(result, ["design_system", "platform"]);
  }

  if (matches("packages/brand/**", file) || matches("packages/design-system/**", file)) {
    merge(result, ["design_system", "platform", "compose"]);
  }

  if (
    matches("web/**", file) ||
    matches("mcp-apps/**", file) ||
    matches("ee/**", file)
  ) {
    // Markdown under them is handled by DOC_ALLOW before we get here.
    merge(result, ["platform", "compose"]);
  }

  if (
    file === "docker-compose.yml" ||
    file === ".env.example" ||
    file === ".dockerignore" ||
    file === "web/Dockerfile" ||
    file === "install.sh" ||
    file === "docker-compose.caddy.yml" ||
    file === "docker-compose.build.yml" ||
    file === "scripts/link-ee.mjs"
  ) {
    merge(result, ["compose", "platform"]);
  }

  // The cloud deployer: its script and modules (deploy job), and its tests (platform job).
  if (file === "deploy.sh" || matches("deploy/**", file)) {
    merge(result, ["deploy", "platform"]);
  }

  return result;
}

/** Walk scripts/ and return paths (posix) that have no SCRIPT_OWNERS entry. */
export function listUnownedScripts(repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")) {
  const scriptsRoot = join(repoRoot, "scripts");
  const unowned = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relative(repoRoot, abs).split(sep).join("/");
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (SCRIPT_OWNERS[rel] === undefined) unowned.push(rel);
    }
  }
  walk(scriptsRoot);
  return unowned.sort();
}

/** Scripts owned by a given owner (for CI job test steps). */
export function scriptsForOwner(owner) {
  return Object.entries(SCRIPT_OWNERS)
    .filter(([, o]) => o === owner)
    .map(([path]) => path)
    .filter((path) => path.endsWith(".test.mjs"))
    .sort();
}

function parseArgs(argv) {
  const files = [];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") {
      json = true;
      continue;
    }
    if (argv[i] === "--files-json") {
      files.push(...JSON.parse(argv[++i]));
      continue;
    }
    if (argv[i] === "--files") {
      // NUL-separated or newline-separated from dorny list-files.
      const raw = argv[++i] ?? "";
      files.push(...raw.split(/\n|\0/).map((s) => s.trim()).filter(Boolean));
      continue;
    }
    files.push(argv[i]);
  }
  return { files, json };
}

function formatGithubOutput(result) {
  return OUTPUTS.map((k) => `${k}=${result[k] ? "true" : "false"}`).join("\n");
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const { files, json } = parseArgs(process.argv.slice(2));
  let list = files;
  if (list.length === 0 && !process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (text) {
      try {
        list = JSON.parse(text);
      } catch {
        list = text.split(/\n|\0/).map((s) => s.trim()).filter(Boolean);
      }
    }
  }
  const result = classify(list);
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(`${formatGithubOutput(result)}\n`);
  }
}
