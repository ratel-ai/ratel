import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

let root;
const script = new URL("./link-ee.mjs", import.meta.url).pathname;
const link = (mode) => execFileSync("node", [join(root, "scripts/link-ee.mjs"), mode], { stdio: "pipe" });
const proxy = () => join(root, "apps/web/proxy.ts");
const route = () => join(root, "apps/web/app/(ee)/admin/page.tsx");

function checkout() {
  mkdirSync(join(root, "ee/src/routes/admin"), { recursive: true });
  writeFileSync(join(root, "ee/src/routes/admin/page.tsx"), "export {};\n");
  writeFileSync(join(root, "ee/src/proxy.ts"), "// the stub\n");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "link-ee-"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "apps/web/app"), { recursive: true });
  copyFileSync(script, join(root, "scripts/link-ee.mjs"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("--auto installs the routes and the proxy stub from a checkout", () => {
  checkout();
  link("--auto");
  assert.ok(existsSync(route()));
  assert.equal(readFileSync(proxy(), "utf8"), "// the stub\n");
});

test("--auto with no checkout removes both, back to the open-source tree", () => {
  checkout();
  link("--auto");
  rmSync(join(root, "ee"), { recursive: true });
  link("--auto");
  assert.equal(existsSync(route()), false);
  assert.equal(existsSync(proxy()), false);
});

test("--unlink removes the proxy stub", () => {
  checkout();
  link("--link");
  link("--unlink");
  assert.equal(existsSync(proxy()), false);
});

test("a checkout with no proxy stub installs none", () => {
  checkout();
  rmSync(join(root, "ee/src/proxy.ts"));
  link("--auto");
  assert.ok(existsSync(route()));
  assert.equal(existsSync(proxy()), false);
});
