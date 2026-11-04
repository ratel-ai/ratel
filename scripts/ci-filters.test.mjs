import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  PACKAGE_DIRS,
  PACKAGE_OUTPUTS,
  SCRIPT_OWNERS,
  classify,
  listUnownedScripts,
  scriptsForOwner,
} from "./ci-filters.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ciWorkflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

function on(files) {
  return classify(files);
}

function assertTrue(result, keys) {
  for (const k of keys) assert.equal(result[k], true, `expected ${k}=true`);
}

function assertFalse(result, keys) {
  for (const k of keys) assert.equal(result[k], false, `expected ${k}=false`);
}

test("design-system-only change runs design_system, platform, compose", () => {
  const r = on(["packages/design-system/src/components/button.tsx"]);
  assertTrue(r, ["design_system", "platform", "compose"]);
  assertFalse(r, ["sdk", "ai_sdk", "rankers_ts", "rust", "python", "release"]);
});

test("brand-only change runs design_system, platform, compose", () => {
  const r = on(["packages/brand/src/tokens.css"]);
  assertTrue(r, ["design_system", "platform", "compose"]);
  assertFalse(r, ["sdk", "rust", "python"]);
});

test("apps/web-only change runs platform and compose", () => {
  const r = on(["apps/web/app/page.tsx"]);
  assertTrue(r, ["platform", "compose"]);
  assertFalse(r, ["design_system", "sdk", "ai_sdk", "rankers_ts", "rust", "python", "release"]);
});

test("sdk/ts change runs sdk, ai_sdk, rankers_ts, release", () => {
  const r = on(["src/sdk/ts/src/index.ts"]);
  assertTrue(r, ["sdk", "ai_sdk", "rankers_ts", "release"]);
  assertFalse(r, ["design_system", "platform", "compose", "rust", "python"]);
});

test("sdk/ts/native change also runs rust", () => {
  const r = on(["src/sdk/ts/native/src/lib.rs"]);
  assertTrue(r, ["sdk", "ai_sdk", "rankers_ts", "rust", "release"]);
  assertFalse(r, ["platform", "compose"]);
});

test("src/core change runs sdk, ai_sdk, rankers_ts, rust, python, release", () => {
  const r = on(["src/core/src/lib.rs"]);
  assertTrue(r, ["sdk", "ai_sdk", "rankers_ts", "rust", "python", "release"]);
  assertFalse(r, ["platform", "compose", "design_system"]);
});

test("markdown under apps/web and src sets no output", () => {
  const r = on(["apps/web/README.md", "src/sdk/ts/README.md"]);
  assertFalse(r, [
    "sdk",
    "ai_sdk",
    "rankers_ts",
    "design_system",
    "platform",
    "compose",
    "rust",
    "python",
    "release",
    "telemetry",
    "protocol",
  ]);
});

test("unclaimed top-level file sets every output", () => {
  const r = on(["NEW_TOP_LEVEL_FILE.txt"]);
  assertTrue(r, [
    "rust",
    "sdk",
    "ai_sdk",
    "rankers_ts",
    "python",
    "telemetry",
    "protocol",
    "design_system",
    "platform",
    "compose",
    "release",
  ]);
});

test("ci.yml change sets every output", () => {
  const r = on([".github/workflows/ci.yml"]);
  assertTrue(r, ["sdk", "platform", "rust", "python", "compose"]);
});

test("setup-branch-ruleset.sh sets every output", () => {
  const r = on(["scripts/setup-branch-ruleset.sh"]);
  assertTrue(r, ["sdk", "platform", "rust"]);
});

test("platform-sync change runs platform only, not sdk", () => {
  const r = on(["scripts/platform-sync/sync.mjs"]);
  assertTrue(r, ["platform"]);
  assertFalse(r, ["sdk", "ai_sdk", "rankers_ts", "rust", "compose"]);
});

test("link-ee.mjs runs platform and compose", () => {
  const r = on(["scripts/link-ee.mjs"]);
  assertTrue(r, ["platform", "compose"]);
  assertFalse(r, ["sdk"]);
});

test("changes-owned scripts set no output", () => {
  const r = on(["scripts/workflow-contracts.test.mjs", "scripts/ci-filters.mjs"]);
  assertFalse(r, ["sdk", "platform", "rust"]);
});

test("inject-sdk-optional-deps sets sdk and release", () => {
  const r = on(["scripts/inject-sdk-optional-deps.mjs"]);
  assertTrue(r, ["sdk", "release"]);
  assertFalse(r, ["platform"]);
});

test("docker-compose.yml sets compose and platform", () => {
  const r = on(["docker-compose.yml"]);
  assertTrue(r, ["compose", "platform"]);
  assertFalse(r, ["sdk"]);
});

test("every file under scripts/ has an owner", () => {
  assert.deepEqual(listUnownedScripts(ROOT), []);
});

test("scriptsForOwner returns only *.test.mjs for that owner", () => {
  for (const path of scriptsForOwner("sdk")) {
    assert.ok(path.endsWith(".test.mjs"));
    assert.equal(SCRIPT_OWNERS[path], "sdk");
  }
  for (const path of scriptsForOwner("platform")) {
    assert.ok(path.endsWith(".test.mjs"));
    assert.equal(SCRIPT_OWNERS[path], "platform");
  }
});

test("workspace dependency directories select the dependent outputs", () => {
  const dirByName = Object.fromEntries(
    Object.entries(PACKAGE_DIRS).map(([dir, name]) => [name, dir]),
  );

  for (const [dir, pkgName] of Object.entries(PACKAGE_DIRS)) {
    const pkg = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
    const deps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    };
    for (const [depName, range] of Object.entries(deps ?? {})) {
      if (typeof range !== "string" || !range.startsWith("workspace:")) continue;
      const depDir = dirByName[depName];
      assert.ok(depDir, `${pkgName} workspace-depends on unknown ${depName}`);
      const required = PACKAGE_OUTPUTS[dir] ?? [];
      // A change to the dependency directory must select every output of the dependent.
      const probe = `${depDir}/package.json`;
      const result = on([probe]);
      for (const out of required) {
        assert.equal(
          result[out],
          true,
          `${probe} must set ${out} because ${pkgName} workspace-depends on ${depName}`,
        );
      }
    }
  }
});

test("ci.yml does not use a packages/** glob for platform or design-system", () => {
  // Comments may mention the ban; job steps and if conditions must not match the glob.
  const withoutComments = ciWorkflow
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.doesNotMatch(withoutComments, /['"]packages\/\*\*['"]/);
  assert.doesNotMatch(withoutComments, /- 'packages\/\*\*'/);
});

test("ci.yml gates legs on classifier outputs, not a ts filter", () => {
  assert.match(ciWorkflow, /needs\.changes\.outputs\.sdk/);
  assert.match(ciWorkflow, /needs\.changes\.outputs\.platform/);
  assert.match(ciWorkflow, /needs\.changes\.outputs\.design_system/);
  assert.doesNotMatch(ciWorkflow, /needs\.changes\.outputs\.ts /);
});
