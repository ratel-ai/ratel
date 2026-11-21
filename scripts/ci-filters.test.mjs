import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  OUTPUTS,
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
  assertFalse(r, ["lockfiles"]);
});

test("brand-only change runs design_system, platform, compose", () => {
  const r = on(["packages/brand/src/tokens.css"]);
  assertTrue(r, ["design_system", "platform", "compose"]);
  assertFalse(r, ["lockfiles"]);
});

test("apps/web-only change runs platform and compose", () => {
  const r = on(["apps/web/app/page.tsx"]);
  assertTrue(r, ["platform", "compose"]);
  assertFalse(r, ["design_system", "lockfiles"]);
});

test("ee change runs platform and compose", () => {
  const r = on(["ee/package.json"]);
  assertTrue(r, ["platform", "compose"]);
  assertFalse(r, ["design_system", "lockfiles"]);
});

test("markdown under apps/web and docs sets no output", () => {
  const r = on(["apps/web/README.md", "docs/README.md", "README.md"]);
  assertFalse(r, ["design_system", "platform", "compose", "lockfiles"]);
});

test("unclaimed top-level file sets every output", () => {
  const r = on(["NEW_TOP_LEVEL_FILE.txt"]);
  assertTrue(r, OUTPUTS);
});

test("ci.yml change sets every output", () => {
  const r = on([".github/workflows/ci.yml"]);
  assertTrue(r, OUTPUTS);
});

test("setup-branch-ruleset.sh sets every output", () => {
  const r = on(["scripts/setup-branch-ruleset.sh"]);
  assertTrue(r, OUTPUTS);
});

test("platform-sync change runs platform only", () => {
  const r = on(["scripts/platform-sync/sync.mjs"]);
  assertTrue(r, ["platform"]);
  assertFalse(r, ["design_system", "compose", "lockfiles"]);
});

test("link-ee.mjs runs platform and compose", () => {
  const r = on(["scripts/link-ee.mjs"]);
  assertTrue(r, ["platform", "compose"]);
  assertFalse(r, ["design_system"]);
});

test("changes-owned scripts set no output", () => {
  const r = on(["scripts/workflow-contracts.test.mjs", "scripts/ci-filters.mjs"]);
  assertFalse(r, OUTPUTS);
});

test("docker-compose.yml sets compose and platform", () => {
  const r = on(["docker-compose.yml"]);
  assertTrue(r, ["compose", "platform"]);
  assertFalse(r, ["design_system"]);
});

test("workspace manifests run design_system, platform and compose", () => {
  for (const f of ["pnpm-workspace.yaml", "package.json"]) {
    const r = on([f]);
    assertTrue(r, ["design_system", "platform", "compose"]);
    assertFalse(r, ["lockfiles"]);
  }
});

test("lockfile and exceptions-file changes set lockfiles", () => {
  for (const f of ["pnpm-lock.yaml", ".trivyignore.yaml"]) {
    assertTrue(on([f]), ["lockfiles"]);
  }
  assertFalse(on(["apps/web/package.json"]), ["lockfiles"]);
});

test("dependabot.yml alone runs no leg", () => {
  const r = on([".github/dependabot.yml"]);
  assertFalse(r, OUTPUTS);
});

test("removed SDK paths are unclaimed and fall back to a full run", () => {
  // The SDKs moved to ratel-ai/ratel-sdk. A path that comes back here is unknown to the
  // classifier, so it runs every leg instead of silently skipping.
  for (const f of ["src/sdk/ts/src/index.ts", "Cargo.toml", "examples/ai-sdk/package.json"]) {
    assertTrue(on([f]), OUTPUTS);
  }
});

test("every file under scripts/ has an owner", () => {
  assert.deepEqual(listUnownedScripts(ROOT), []);
});

test("scriptsForOwner returns only *.test.mjs for that owner", () => {
  assert.ok(scriptsForOwner("platform").length > 0);
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
  assert.match(ciWorkflow, /needs\.changes\.outputs\.platform/);
  assert.match(ciWorkflow, /needs\.changes\.outputs\.compose/);
  assert.match(ciWorkflow, /needs\.changes\.outputs\.lockfiles/);
  assert.match(ciWorkflow, /needs\.changes\.outputs\.design_system/);
  assert.doesNotMatch(ciWorkflow, /needs\.changes\.outputs\.ts /);
});

test("the changes job exposes exactly the classifier outputs", () => {
  const changes = ciWorkflow.slice(ciWorkflow.indexOf("\n  changes:"), ciWorkflow.indexOf("\n    steps:"));
  const exposed = [...changes.matchAll(/^ {6}([a-z_]+): \$\{\{ steps\.c\.outputs\.([a-z_]+) \}\}$/gm)];
  assert.deepEqual(exposed.map((m) => m[1]).sort(), [...OUTPUTS].sort());
  for (const m of exposed) assert.equal(m[1], m[2]);
});

test("ci.yml reads only outputs the classifier emits", () => {
  for (const [, name] of ciWorkflow.matchAll(/needs\.changes\.outputs\.([a-z_]+)/g)) {
    assert.ok(OUTPUTS.includes(name), `ci.yml reads unknown output ${name}`);
  }
});
