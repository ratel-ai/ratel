// The rankers plugins' SDK floor (ADR-0028): the TS and Python floors agree,
// and npm really installs the TS plugin next to a newer SDK prerelease.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const tsPkg = JSON.parse(
  readFileSync(new URL("../src/rankers/ts/package.json", import.meta.url), "utf8"),
);
const pyproject = readFileSync(
  new URL("../src/rankers/python/pyproject.toml", import.meta.url),
  "utf8",
);
const floor = tsPkg.ratel.sdkFloor;

/** `0.13.0-rc.12` → `0.13.0rc12`: a semver prerelease in PEP 440 spelling. */
function pep440(version) {
  return version.replace(/-(alpha|beta|rc)\.?(\d+)$/, (_, tag, n) => {
    return `${{ alpha: "a", beta: "b", rc: "rc" }[tag]}${n}`;
  });
}

test("the TS and Python plugins require the same SDK floor", () => {
  const match = pyproject.match(/"ratel-ai>=([^,"]+)/);
  assert.ok(match, "pyproject.toml must require ratel-ai>=<floor>");
  assert.equal(match[1], pep440(floor), "bump ratel.sdkFloor and the ratel-ai floor together");
});

test("pep440 spells semver prereleases the PEP 440 way", () => {
  assert.equal(pep440("0.13.0-rc.12"), "0.13.0rc12");
  assert.equal(pep440("1.2.0-beta.3"), "1.2.0b3");
  assert.equal(pep440("1.2.0"), "1.2.0");
});

/** Pack a stub package.json into a tarball under `dir`; returns its path. */
function pack(dir, name, manifest) {
  const src = join(dir, name);
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "package.json"), JSON.stringify(manifest));
  const file = execFileSync("npm", ["pack", "--silent", "--pack-destination", dir], {
    cwd: src,
    encoding: "utf8",
  }).trim();
  return join(dir, file);
}

/** `npm install` a stub plugin with `peer` next to a stub SDK at `sdkVersion`, offline. */
function installsWith(peer, sdkVersion) {
  const dir = mkdtempSync(join(tmpdir(), "rankers-peer-"));
  try {
    const sdk = pack(dir, "sdk", { name: "@ratel-ai/sdk", version: sdkVersion });
    const plugin = pack(dir, "plugin", {
      name: "@ratel-ai/rankers-plugin",
      version: "0.0.0-test",
      peerDependencies: { "@ratel-ai/sdk": peer },
    });
    const app = join(dir, "app");
    mkdirSync(app);
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "app", private: true }));
    const result = spawnSync(
      "npm",
      ["install", "--offline", "--no-audit", "--no-fund", "--loglevel=error", sdk, plugin],
      { cwd: app, encoding: "utf8" },
    );
    return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The next minor's first RC, e.g. 0.14.0-rc.1 for a 0.13.0-rc.12 floor.
const [major, minor] = floor.split(".").map(Number);
const nextRc = `${major}.${minor + 1}.0-rc.1`;
const peer = tsPkg.peerDependencies["@ratel-ai/sdk"];

test(`npm installs the plugin's real peer next to a newer SDK prerelease (${nextRc})`, () => {
  const { ok, output } = installsWith(peer, nextRc);
  assert.ok(ok, `peer ${JSON.stringify(peer)} must admit ${nextRc}:\n${output}`);
});

test("a floor range would reject that prerelease, which is why the peer is \"*\"", () => {
  const { ok, output } = installsWith(`>=${floor} <1.0.0`, nextRc);
  assert.equal(ok, false, "control: npm must reject a later prerelease under a range");
  assert.match(output, /ERESOLVE|peer/i);
});

// npm's `latest` SDK sits below a prerelease floor, and the "*" peer means npm
// never says so: a bare install fails at import (ADR-0028). So while the floor
// is a prerelease, every documented TS install pins both packages to `@rc`.
const docs = {
  "src/rankers/ts/README.md": readFileSync(
    new URL("../src/rankers/ts/README.md", import.meta.url),
    "utf8",
  ),
  "llms.txt": readFileSync(new URL("../llms.txt", import.meta.url), "utf8"),
};

for (const [path, text] of Object.entries(docs)) {
  test(`${path} installs the TS plugin with an SDK at or above a prerelease floor`, {
    skip: !floor.includes("-") && "floor is GA, so @latest satisfies it",
  }, () => {
    const installs = text
      .split("\n")
      .filter((line) => /(npm install|pnpm add) .*@ratel-ai\/rankers-plugin/.test(line));
    assert.ok(installs.length > 0, `${path} must document the TS install`);
    for (const line of installs) {
      assert.match(line, /@ratel-ai\/sdk@rc\b/, `${path}: pin the SDK to @rc: ${line}`);
      assert.match(line, /@ratel-ai\/rankers-plugin@rc\b/, `${path}: pin the plugin to @rc: ${line}`);
    }
  });
}
