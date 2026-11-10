import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloudCheckout } from "./cloud-checkout.mjs";

function checkout() {
  const root = mkdtempSync(join(tmpdir(), "parity-cloud-"));
  mkdirSync(join(root, "apps", "web"), { recursive: true });
  writeFileSync(join(root, "apps", "web", "package.json"), "{}\n");
  const git = (...args) =>
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "one");
  return { root, head: git("rev-parse", "HEAD") };
}

test("a checkout at the synced commit is accepted", () => {
  const { root, head } = checkout();
  try {
    assert.equal(cloudCheckout(root, head), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a checkout at any other commit is refused, naming both commits", () => {
  const { root, head } = checkout();
  try {
    const other = "2848c52c1b6f91e6eeb6b533e2082d2847dbe1df";
    assert.throws(
      () => cloudCheckout(root, other),
      (error) => error.message.includes(`is at ${head.slice(0, 8)}, not at 2848c52c`) && error.message.includes("source.json"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no directory, a folder that is not Cloud, and a folder that is not a git checkout are refused", () => {
  assert.throws(() => cloudCheckout(undefined, "abc"), /RATEL_CLOUD_DIR is not set/);
  const plain = mkdtempSync(join(tmpdir(), "parity-plain-"));
  try {
    assert.throws(() => cloudCheckout(plain, "abc"), /not a ratel-cloud checkout/);
    mkdirSync(join(plain, "apps", "web"), { recursive: true });
    writeFileSync(join(plain, "apps", "web", "package.json"), "{}\n");
    assert.throws(() => cloudCheckout(plain, "abc"), /not a git checkout|is at /);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});
