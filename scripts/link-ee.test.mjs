import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

let root;
const script = new URL("./link-ee.mjs", import.meta.url).pathname;
const link = (mode) => execFileSync("node", [join(root, "scripts/link-ee.mjs"), mode], { stdio: "pipe" });
const proxy = () => join(root, "web/src/proxy.ts");
const route = () => join(root, "web/src/app/(ee)/admin/page.tsx");

function checkout() {
  mkdirSync(join(root, "ee/src/src/routes/admin"), { recursive: true });
  writeFileSync(join(root, "ee/src/src/routes/admin/page.tsx"), "export {};\n");
  writeFileSync(join(root, "ee/src/src/proxy.ts"), "// the stub\n");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "link-ee-"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "web/src/app"), { recursive: true });
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
  rmSync(join(root, "ee/src/src/proxy.ts"));
  link("--auto");
  assert.ok(existsSync(route()));
  assert.equal(existsSync(proxy()), false);
});

const placed = () => join(root, "web/public/email/mark.png");
const corePublic = () => join(root, "web/public/icon.png");

function publicFiles() {
  mkdirSync(join(root, "ee/src/src/public/email"), { recursive: true });
  writeFileSync(join(root, "ee/src/src/public/email/mark.png"), "edition mark");
  mkdirSync(join(root, "web/public"), { recursive: true });
  writeFileSync(corePublic(), "core icon");
}

test("--auto places the edition's public files as real files beside the app's own", () => {
  checkout();
  publicFiles();
  link("--auto");
  assert.equal(readFileSync(placed(), "utf8"), "edition mark");
  // A copy, not a link: the standalone image copies web/public on its own.
  assert.equal(lstatSync(placed()).isSymbolicLink(), false);
  assert.equal(readFileSync(corePublic(), "utf8"), "core icon");
});

test("an edition file removed from the checkout goes from the app at the next run", () => {
  checkout();
  publicFiles();
  link("--auto");
  rmSync(join(root, "ee/src/src/public/email/mark.png"));
  link("--auto");
  assert.equal(existsSync(placed()), false);
  assert.equal(existsSync(join(root, "web/public/email")), false);
});

const placedGone = () => {
  assert.equal(existsSync(placed()), false);
  assert.equal(existsSync(join(root, "web/public/email")), false);
  assert.equal(readFileSync(corePublic(), "utf8"), "core icon");
};

test("--auto with no checkout removes the placed files and keeps the app's own", () => {
  checkout();
  publicFiles();
  link("--auto");
  rmSync(join(root, "ee"), { recursive: true });
  link("--auto");
  placedGone();
});

test("--unlink removes the placed files and keeps the app's own", () => {
  checkout();
  publicFiles();
  link("--link");
  link("--unlink");
  placedGone();
});

test("an edition file never replaces one the app ships", () => {
  checkout();
  publicFiles();
  writeFileSync(join(root, "ee/src/src/public/icon.png"), "edition icon");
  link("--auto");
  assert.equal(readFileSync(corePublic(), "utf8"), "core icon");
  assert.equal(readFileSync(placed(), "utf8"), "edition mark");
  link("--unlink");
  assert.equal(readFileSync(corePublic(), "utf8"), "core icon");
});

test("with no edition, nothing is placed", () => {
  mkdirSync(join(root, "web/public"), { recursive: true });
  writeFileSync(corePublic(), "core icon");
  link("--auto");
  assert.deepEqual(readdirSync(join(root, "web/public")), ["icon.png"]);
  assert.deepEqual(readdirSync(join(root, "web")).sort(), ["public", "src"]);
  assert.deepEqual(readdirSync(join(root, "web/src")), ["app"]);
});

test("the files placed in this repository are git-ignored", () => {
  const repo = new URL("..", import.meta.url).pathname;
  for (const file of ["web/public/email/ratel-mark.png", "web/.ee-public.json"]) {
    const out = execFileSync("git", ["check-ignore", "--no-index", file], { cwd: repo, encoding: "utf8" });
    assert.equal(out.trim(), file);
  }
});
