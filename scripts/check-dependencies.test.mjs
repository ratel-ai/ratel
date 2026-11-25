import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

const script = new URL("./check-dependencies.mjs", import.meta.url).pathname;
let root;

const json = (file, value) => {
  const full = join(root, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(value));
};
const allow = (...names) => json("scripts/dependencies-allow.json", names);
const check = () => {
  const run = spawnSync("node", [script, root], { encoding: "utf8" });
  return { code: run.status, out: run.stdout + run.stderr };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "check-dependencies-"));
  json("package.json", { name: "root", devDependencies: { biome: "1" } });
  json("web/package.json", { name: "web", dependencies: { react: "1" } });
  json("mcp-apps/package.json", { name: "mcp-apps" });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("passes when every direct dependency is approved", () => {
  allow("biome", "react");
  assert.deepEqual(check(), { code: 0, out: "dependencies clean: 2 approved\n" });
});

test("refuses an unapproved dependency and names the package that declares it", () => {
  allow("biome");
  const { code, out } = check();
  assert.equal(code, 1);
  assert.match(out, /web\/package\.json: react is not in scripts\/dependencies-allow\.json/);
});

for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
  test(`reads ${field}`, () => {
    allow("biome", "react");
    json("packages/ui/package.json", { name: "ui", [field]: { surprise: "1" } });
    const { code, out } = check();
    assert.equal(code, 1);
    assert.match(out, /packages\/ui\/package\.json: surprise /);
  });
}

test("an alias is checked by the package it installs", () => {
  allow("biome", "react");
  json("web/package.json", { dependencies: { react: "npm:@other/react@1.2.3" } });
  const { code, out } = check();
  assert.equal(code, 1);
  assert.match(out, /web\/package\.json: @other\/react /);
});

test("a workspace package needs no approval", () => {
  allow("biome", "react");
  json("mcp-apps/package.json", { dependencies: { ui: "workspace:*" } });
  assert.equal(check().code, 0);
});

test("ee keeps its own dependencies", () => {
  allow("biome", "react");
  json("ee/package.json", { dependencies: { vendor: "1" } });
  assert.equal(check().code, 0);
});

test("a stale entry fails, so the list only holds what is used", () => {
  allow("biome", "gone", "react");
  const { code, out } = check();
  assert.equal(code, 1);
  assert.match(out, /gone is approved but not used/);
});
