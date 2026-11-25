import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
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

const runAuto = () => spawnSync("node", [join(root, "scripts/link-ee.mjs"), "--auto"], { encoding: "utf8" });

function installer(body) {
  mkdirSync(join(root, "ee/src/scripts"), { recursive: true });
  writeFileSync(join(root, "ee/src/scripts/install-hooks.sh"), body);
}

test("--auto runs the checkout's hook installer from the repository root", () => {
  checkout();
  installer("pwd -P > installed-from\n");
  link("--auto");
  assert.equal(readFileSync(join(root, "installed-from"), "utf8").trim(), realpathSync(root));
});

test("a hook installer that fails warns, and the routes are still installed", () => {
  checkout();
  installer("echo 'no git here' >&2\nexit 3\n");
  const run = runAuto();
  assert.equal(run.status, 0);
  assert.match(run.stderr, /no git here/);
  assert.match(run.stderr, /could not install the git hooks/);
  assert.ok(existsSync(route()));
});

test("a checkout with no hook installer prints nothing", () => {
  checkout();
  const run = runAuto();
  assert.equal(run.status, 0);
  assert.equal(run.stdout + run.stderr, "");
});

test("the files placed in this repository are git-ignored", () => {
  const repo = new URL("..", import.meta.url).pathname;
  for (const file of ["web/public/email/ratel-mark.png", "web/.ee-public.json"]) {
    const out = execFileSync("git", ["check-ignore", "--no-index", file], { cwd: repo, encoding: "utf8" });
    assert.equal(out.trim(), file);
  }
});
