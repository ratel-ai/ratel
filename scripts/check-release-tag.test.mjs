import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { parseTag, distTagFor, checkReleaseTag } from "./check-release-tag.mjs";

// Build a minimal repo tree where every release unit sits at `version` (npm/crate
// string) with a matching CHANGELOG heading. Individual tests override pieces.
function makeRepo(version = "0.2.0", pyVersion = version) {
  const root = mkdtempSync(join(tmpdir(), "ratel-reltag-"));
  const write = (rel, body) => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };
  const json = (name) => JSON.stringify({ name, version }, null, 2);
  const cargo = (name) => `[package]\nname = "${name}"\nversion = "${version}" # comment\nedition = "2024"\n`;
  const changelog = (v) => `# Changelog\n\n## [Unreleased]\n\n## [${v}] - 2026-07-04\n\n### Added\n- thing\n`;

  // core
  write("src/core/Cargo.toml", cargo("ratel-ai-core"));
  write("src/core/CHANGELOG.md", changelog(version));
  // js sdk: loader + 5 platform packages + ts-native crate
  write("src/sdk/ts/package.json", json("@ratel-ai/sdk"));
  for (const t of ["darwin-arm64", "darwin-x64", "linux-x64-gnu", "linux-arm64-gnu", "win32-x64-msvc"]) {
    write(`src/sdk/ts/npm/${t}/package.json`, json(`@ratel-ai/sdk-${t}`));
  }
  write("src/sdk/ts/native/Cargo.toml", cargo("ratel-sdk-ts-native"));
  write("src/sdk/ts/CHANGELOG.md", changelog(version));
  // python sdk: pyproject + py-native crate
  write("src/sdk/python/pyproject.toml", `[project]\nname = "ratel-ai"\nversion = "${pyVersion}"\n`);
  write("src/sdk/python/native/Cargo.toml", cargo("ratel-sdk-python-native"));
  write("src/sdk/python/CHANGELOG.md", changelog(version));
  // telemetry: the first 3-registry unit — npm + PyPI + crate all move together.
  write("src/telemetry/ts/package.json", json("@ratel-ai/telemetry"));
  write("src/telemetry/ts/CHANGELOG.md", changelog(version));
  write("src/telemetry/python/pyproject.toml", `[project]\nname = "ratel-ai-telemetry"\nversion = "${pyVersion}"\n`);
  write("src/telemetry/python/CHANGELOG.md", changelog(version));
  write("src/telemetry/core/Cargo.toml", cargo("ratel-ai-telemetry"));
  write("src/telemetry/core/CHANGELOG.md", changelog(version));

  return { root, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("parseTag splits prefix and version for every unit", () => {
  assert.deepEqual(parseTag("core-v0.2.0"), { unit: "core", version: "0.2.0" });
  assert.deepEqual(parseTag("sdk-js-v0.2.0"), { unit: "sdk-js", version: "0.2.0" });
  assert.deepEqual(parseTag("sdk-py-v1.4.0-rc.2"), { unit: "sdk-py", version: "1.4.0-rc.2" });
  assert.deepEqual(parseTag("telemetry-v0.1.0-rc.1"), { unit: "telemetry", version: "0.1.0-rc.1" });
});

test("parseTag rejects the old lockstep tag and unknown prefixes", () => {
  assert.equal(parseTag("v0.2.0"), null);
  assert.equal(parseTag("server-v0.1.0"), null); // not (yet) a registered unit
  assert.equal(parseTag("sdk-js-0.2.0"), null); // missing the -v
  assert.equal(parseTag("core-vX.Y.Z"), null); // non-semver
});

test("distTagFor maps rc vs GA", () => {
  assert.equal(distTagFor("0.2.0"), "latest");
  assert.equal(distTagFor("0.2.0-rc.1"), "rc");
});

test("core GA tag passes when the crate + changelog match", () => {
  const repo = makeRepo("0.2.0");
  try {
    const r = checkReleaseTag("core-v0.2.0", { root: repo.root });
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.equal(r.unit, "core");
    assert.equal(r.version, "0.2.0");
    assert.equal(r.distTag, "latest");
  } finally {
    repo.cleanup();
  }
});

test("sdk-js rc tag passes only when loader + all 5 platforms + ts-native match", () => {
  const repo = makeRepo("0.3.0-rc.1");
  try {
    const r = checkReleaseTag("sdk-js-v0.3.0-rc.1", { root: repo.root });
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.equal(r.distTag, "rc");
  } finally {
    repo.cleanup();
  }
});

test("sdk-js fails if a single platform package drifts", () => {
  const repo = makeRepo("0.3.0");
  try {
    // linux-arm64-gnu lags behind the loader
    repo.write(
      "src/sdk/ts/npm/linux-arm64-gnu/package.json",
      JSON.stringify({ name: "@ratel-ai/sdk-linux-arm64-gnu", version: "0.2.0" }, null, 2),
    );
    const r = checkReleaseTag("sdk-js-v0.3.0", { root: repo.root });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("linux-arm64-gnu")), r.errors.join("; "));
  } finally {
    repo.cleanup();
  }
});

test("sdk-py accepts the PEP 440 normalized form in pyproject", () => {
  // tag says 0.2.0-rc.1; pyproject stores the PEP 440 form 0.2.0rc1
  const repo = makeRepo("0.2.0-rc.1", "0.2.0rc1");
  try {
    const r = checkReleaseTag("sdk-py-v0.2.0-rc.1", { root: repo.root });
    assert.equal(r.ok, true, r.errors.join("; "));
  } finally {
    repo.cleanup();
  }
});

test("sdk-py fails when the CHANGELOG lacks the version heading", () => {
  const repo = makeRepo("0.2.0");
  try {
    repo.write("src/sdk/python/CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n");
    const r = checkReleaseTag("sdk-py-v0.2.0", { root: repo.root });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("CHANGELOG")), r.errors.join("; "));
  } finally {
    repo.cleanup();
  }
});

test("telemetry rc tag passes when npm + PyPI + crate manifests + all 3 CHANGELOGs match", () => {
  // telemetry is the first unit spanning three registries; the tag gate must
  // check the loader package.json, the pyproject (PEP 440), AND the crate Cargo.toml.
  const repo = makeRepo("0.1.0-rc.1", "0.1.0rc1");
  try {
    const r = checkReleaseTag("telemetry-v0.1.0-rc.1", { root: repo.root });
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.equal(r.unit, "telemetry");
    assert.equal(r.distTag, "rc");
  } finally {
    repo.cleanup();
  }
});

test("telemetry fails when the crate version lags the npm/PyPI version", () => {
  const repo = makeRepo("0.1.0");
  try {
    repo.write(
      "src/telemetry/core/Cargo.toml",
      `[package]\nname = "ratel-ai-telemetry"\nversion = "0.0.9"\nedition = "2024"\n`,
    );
    const r = checkReleaseTag("telemetry-v0.1.0", { root: repo.root });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("telemetry/core/Cargo.toml")), r.errors.join("; "));
  } finally {
    repo.cleanup();
  }
});

test("a core tag only checks the core unit, ignoring drift elsewhere", () => {
  const repo = makeRepo("0.2.0");
  try {
    // the JS SDK is on a totally different version — must not affect a core release
    repo.write("src/sdk/ts/package.json", JSON.stringify({ name: "@ratel-ai/sdk", version: "9.9.9" }, null, 2));
    const r = checkReleaseTag("core-v0.2.0", { root: repo.root });
    assert.equal(r.ok, true, r.errors.join("; "));
  } finally {
    repo.cleanup();
  }
});

test("version mismatch between tag and manifest fails", () => {
  const repo = makeRepo("0.2.0");
  try {
    const r = checkReleaseTag("core-v0.3.0", { root: repo.root });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("0.3.0")), r.errors.join("; "));
  } finally {
    repo.cleanup();
  }
});

test("an unroutable tag is reported, not silently passed", () => {
  const repo = makeRepo("0.2.0");
  try {
    const r = checkReleaseTag("v0.2.0", { root: repo.root });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.toLowerCase().includes("tag")), r.errors.join("; "));
  } finally {
    repo.cleanup();
  }
});
