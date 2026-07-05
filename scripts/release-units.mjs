#!/usr/bin/env node
// Single source of truth for Ratel's release units (ADR-0016).
//
// Every release-infra tool reads unit facts from HERE so the three units can
// never drift apart:
//   - scripts/check-release-tag.mjs  — the per-tag manifest + CHANGELOG gate
//   - scripts/releasable.mjs         — "which units have commits since their tag"
//   - scripts/publish-rc.sh          — the manual first-publish helper (--unit)
//   - .claude/skills/changelog/draft.sh — via the `--changelog-map` CLI below
//
// Adding a 4th unit later (e.g. `server`, `telemetry`) is a one-place change.
//
// Per unit:
//   tagPrefix        release tag prefix; a unit ships on `<tagPrefix><semver>`.
//   label            human one-liner (registry destination) for docs/CLIs.
//   versionManifest  the manifest whose version string is canonical for the unit.
//   manifests        every manifest that MUST carry the tag version (tag gate).
//   changelogs       CHANGELOG(s) that MUST record the version (tag gate).
//   srcPaths         git pathspecs that make the unit "releasable" when they
//                    carry commits since its last tag (releasable.mjs).
//   changelog        git-cliff scope: { name, includePaths } (draft.sh).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64-gnu", "linux-arm64-gnu", "win32-x64-msvc"];

export const UNITS = {
  core: {
    tagPrefix: "core-v",
    label: "ratel-ai-core → crates.io",
    versionManifest: { path: "src/core/Cargo.toml", kind: "toml" },
    manifests: [{ path: "src/core/Cargo.toml", kind: "toml" }],
    changelogs: ["src/core/CHANGELOG.md"],
    srcPaths: ["src/core"],
    changelog: { name: "ratel-ai-core", includePaths: ["src/core/**", "Cargo.toml"] },
  },
  "sdk-js": {
    tagPrefix: "sdk-js-v",
    label: "@ratel-ai/sdk (loader + 5 platform packages) → npm",
    // The JS SDK is internally lockstep: loader + five platform packages + the
    // ts-native crate all move together on one sdk-js-v* tag.
    versionManifest: { path: "src/sdk/ts/package.json", kind: "json" },
    manifests: [
      { path: "src/sdk/ts/package.json", kind: "json" },
      ...PLATFORMS.map((t) => ({ path: `src/sdk/ts/npm/${t}/package.json`, kind: "json" })),
      { path: "src/sdk/ts/native/Cargo.toml", kind: "toml" },
    ],
    changelogs: ["src/sdk/ts/CHANGELOG.md"],
    srcPaths: ["src/sdk/ts"],
    changelog: { name: "@ratel-ai/sdk", includePaths: ["src/sdk/ts/**"] },
  },
  "sdk-py": {
    tagPrefix: "sdk-py-v",
    label: "ratel-ai → PyPI",
    versionManifest: { path: "src/sdk/python/pyproject.toml", kind: "toml", pep440: true },
    manifests: [
      { path: "src/sdk/python/pyproject.toml", kind: "toml", pep440: true },
      { path: "src/sdk/python/native/Cargo.toml", kind: "toml" },
    ],
    changelogs: ["src/sdk/python/CHANGELOG.md"],
    srcPaths: ["src/sdk/python"],
    changelog: { name: "ratel-ai", includePaths: ["src/sdk/python/**"] },
  },
  telemetry: {
    tagPrefix: "telemetry-v",
    label: "@ratel-ai/telemetry (npm) + ratel-ai-telemetry (PyPI + crates.io)",
    // The first 3-registry unit: the npm loader, the pure-python wheel, and the
    // constants crate share one telemetry-v* tag and move in lockstep. The npm
    // package.json is canonical; the pyproject carries the PEP 440 spelling.
    versionManifest: { path: "src/telemetry/ts/package.json", kind: "json" },
    manifests: [
      { path: "src/telemetry/ts/package.json", kind: "json" },
      { path: "src/telemetry/python/pyproject.toml", kind: "toml", pep440: true },
      { path: "src/telemetry/core/Cargo.toml", kind: "toml" },
    ],
    changelogs: [
      "src/telemetry/ts/CHANGELOG.md",
      "src/telemetry/python/CHANGELOG.md",
      "src/telemetry/core/CHANGELOG.md",
    ],
    srcPaths: ["src/telemetry"],
    changelog: { name: "ratel-ai-telemetry", includePaths: ["src/telemetry/**"] },
  },
};

export const UNIT_IDS = Object.keys(UNITS);

// Accepted release version: semver with an optional `-rc.N` pre-release.
export const SEMVER = /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/;

// Regex alternation of the registered unit ids, derived so a new unit needs no
// hand-edited regex anywhere. `sdk-js` etc. are literal in a character run.
export function unitIdAlternation() {
  return UNIT_IDS.join("|");
}

// The canonical version string a unit currently carries, read from its
// versionManifest. Shared so bash tools (publish-rc.sh) never re-hardcode a
// manifest path. Returns the raw manifest string (PEP 440 form for sdk-py).
export function versionOf(unit, root = process.cwd()) {
  const spec = UNITS[unit];
  if (!spec) throw new Error(`unknown unit: ${unit}`);
  const { path, kind } = spec.versionManifest;
  const body = readFileSync(`${root}/${path}`, "utf8");
  if (kind === "json") return JSON.parse(body).version ?? null;
  return /^version\s*=\s*"([^"]+)"/m.exec(body)?.[1] ?? null;
}

// ---- tiny CLI so bash tools (draft.sh) share this one registry ----
//   node scripts/release-units.mjs --list
//   node scripts/release-units.mjs --changelog-map [unit]
//   node scripts/release-units.mjs --tag-prefix <unit>
function main(argv) {
  const [cmd, arg] = argv.slice(2);
  switch (cmd) {
    case "--list":
      process.stdout.write(`${UNIT_IDS.join("\n")}\n`);
      return;
    case "--changelog-map": {
      // One `name|glob1|glob2...` line per unit (or just `arg`), consumed by
      // draft.sh so the git-cliff package list lives in exactly one place.
      const ids = arg ? [arg] : UNIT_IDS;
      for (const id of ids) {
        const u = UNITS[id];
        if (!u) {
          process.stderr.write(`unknown unit: ${id}\n`);
          process.exit(2);
        }
        process.stdout.write(`${[u.changelog.name, ...u.changelog.includePaths].join("|")}\n`);
      }
      return;
    }
    case "--tag-prefix": {
      const u = UNITS[arg];
      if (!u) {
        process.stderr.write(`unknown unit: ${arg}\n`);
        process.exit(2);
      }
      process.stdout.write(`${u.tagPrefix}\n`);
      return;
    }
    case "--version": {
      try {
        process.stdout.write(`${versionOf(arg)}\n`);
      } catch (e) {
        process.stderr.write(`${e.message}\n`);
        process.exit(2);
      }
      return;
    }
    default:
      process.stderr.write(
        "usage: release-units.mjs --list | --changelog-map [unit] | --tag-prefix <unit> | --version <unit>\n",
      );
      process.exit(2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
