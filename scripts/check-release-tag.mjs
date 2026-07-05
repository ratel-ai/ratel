#!/usr/bin/env node
// Per-unit release-tag gate (ADR-0016). A release is cut by pushing a prefixed
// tag: `core-v*`, `sdk-js-v*`, `sdk-py-v*`, or `cli-v*`. This checks that ONLY
// the tagged unit's manifests carry the tag's version and that its CHANGELOG(s)
// record it — nothing else in the repo has to be in lockstep.
//
// Usage (from repo root):
//   node scripts/check-release-tag.mjs <tag> [--root <dir>]
// On success it writes `unit`, `version`, `dist_tag` to $GITHUB_OUTPUT (when set)
// and exits 0; on any mismatch it prints ::error:: lines and exits 1.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Each release unit -> the manifests that must match the tag version and the
// CHANGELOG(s) that must record it. The JS SDK is internally lockstep: loader +
// five platform packages + the ts-native crate all move together.
const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64-gnu", "linux-arm64-gnu", "win32-x64-msvc"];

const UNITS = {
  core: {
    manifests: [{ path: "src/core/Cargo.toml", kind: "toml" }],
    changelogs: ["src/core/CHANGELOG.md"],
  },
  "sdk-js": {
    manifests: [
      { path: "src/sdk/ts/package.json", kind: "json" },
      ...PLATFORMS.map((t) => ({ path: `src/sdk/ts/npm/${t}/package.json`, kind: "json" })),
      { path: "src/sdk/ts/native/Cargo.toml", kind: "toml" },
    ],
    changelogs: ["src/sdk/ts/CHANGELOG.md"],
  },
  "sdk-py": {
    manifests: [
      { path: "src/sdk/python/pyproject.toml", kind: "toml", pep440: true },
      { path: "src/sdk/python/native/Cargo.toml", kind: "toml" },
    ],
    changelogs: ["src/sdk/python/CHANGELOG.md"],
  },
  cli: {
    manifests: [{ path: "src/cli/package.json", kind: "json" }],
    changelogs: ["src/cli/CHANGELOG.md"],
  },
};

const SEMVER = /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/;

// `<prefix>-v<semver>` -> { unit, version }. Anything else (the old lockstep
// `v0.2.0`, an unknown prefix, a non-semver body) returns null so the caller can
// fail loudly instead of routing a tag nowhere.
export function parseTag(tag) {
  const m = /^(core|sdk-js|sdk-py|cli)-v(.+)$/.exec(tag ?? "");
  if (!m) return null;
  const [, unit, version] = m;
  if (!SEMVER.test(version)) return null;
  return { unit, version };
}

export function distTagFor(version) {
  return version.includes("-rc.") ? "rc" : "latest";
}

// PyPI/PEP 440 normalizes pre-releases (`0.2.0-rc.1` -> `0.2.0rc1`), so pyproject
// may legitimately hold the normalized form. Accept either spelling.
function pep440(version) {
  return version.replace(/-?rc\.?(\d+)/, "rc$1");
}

function readVersion(abs, kind) {
  const body = readFileSync(abs, "utf8");
  if (kind === "json") return JSON.parse(body).version ?? null;
  const m = /^version\s*=\s*"([^"]+)"/m.exec(body);
  return m ? m[1] : null;
}

export function checkReleaseTag(tag, { root = process.cwd() } = {}) {
  const parsed = parseTag(tag);
  if (!parsed) {
    return {
      ok: false,
      unit: null,
      version: null,
      distTag: null,
      errors: [`unroutable tag "${tag}" — expected <core|sdk-js|sdk-py|cli>-v<semver>`],
    };
  }

  const { unit, version } = parsed;
  const spec = UNITS[unit];
  const errors = [];

  for (const { path, kind, pep440: isPy } of spec.manifests) {
    let found;
    try {
      found = readVersion(join(root, path), kind);
    } catch {
      errors.push(`${path}: cannot read version (missing manifest?)`);
      continue;
    }
    const accepted = isPy ? [version, pep440(version)] : [version];
    if (!accepted.includes(found)) {
      errors.push(`${path}: version ${found ?? "(none)"} does not match tag ${version}`);
    }
  }

  const heading = `## [${version}]`;
  for (const path of spec.changelogs) {
    let body;
    try {
      body = readFileSync(join(root, path), "utf8");
    } catch {
      errors.push(`${path}: cannot read CHANGELOG (missing?)`);
      continue;
    }
    if (!body.includes(heading)) {
      errors.push(`${path}: missing "${heading}" — run /changelog before tagging`);
    }
  }

  return { ok: errors.length === 0, unit, version, distTag: distTagFor(version), errors };
}

function main(argv) {
  const args = argv.slice(2);
  let tag;
  let root = process.cwd();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root") root = args[++i];
    else if (!tag) tag = args[i];
  }
  if (!tag) {
    console.error("::error::usage: check-release-tag.mjs <tag> [--root <dir>]");
    process.exit(2);
  }

  const r = checkReleaseTag(tag, { root });
  if (!r.ok) {
    for (const e of r.errors) console.error(`::error::${e}`);
    process.exit(1);
  }

  const out = `unit=${r.unit}\nversion=${r.version}\ndist_tag=${r.distTag}\n`;
  if (process.env.GITHUB_OUTPUT) {
    // Lazy import so the module stays usable in tests without the fs write path.
    import("node:fs").then(({ appendFileSync }) => appendFileSync(process.env.GITHUB_OUTPUT, out));
  }
  console.log(`${r.unit} ${r.version} (${r.distTag}) — manifests + CHANGELOG verified`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
