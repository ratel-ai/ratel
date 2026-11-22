import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBundle, bundleFiles } from "./bundle.js";

// The bundle of `ratel sandbox push`, on throwaway projects: with git (its file
// list, minus .gitignore) and without (a walk). Both always drop .env files,
// dependencies, .git and build output.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ratel-bundle-"));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const git = (root: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: root, stdio: "ignore" });

const FILES = {
  "agent.sandbox.ts": "export default 1;\n",
  "src/agent.ts": "export const a = 1;\n",
  "db/seed.sql": "select 1;\n",
  ".gitignore": "secret.txt\n",
  "secret.txt": "ignored by .gitignore\n",
  ".env": "OPENAI_API_KEY=sk-1\n",
  ".env.local": "X=1\n",
  "config/.env.production": "X=2\n",
  "node_modules/pkg/index.js": "module.exports = 1;\n",
  "dist/agent.js": "built\n",
};

describe("bundleFiles", () => {
  it("in a git checkout: tracked and untracked files, minus .gitignore and the always-excluded", () => {
    const root = project(FILES);
    git(root, "init", "-q");
    git(root, "add", "-f", ".env", "dist/agent.js"); // tracked, still never bundled
    expect(bundleFiles(root)).toEqual([
      ".gitignore",
      "agent.sandbox.ts",
      "db/seed.sql",
      "src/agent.ts",
    ]);
  });

  it("outside git: every file, minus the always-excluded", () => {
    const root = project(FILES);
    expect(bundleFiles(root)).toEqual([
      ".gitignore",
      "agent.sandbox.ts",
      "db/seed.sql",
      "secret.txt",
      "src/agent.ts",
    ]);
  });
});

describe("buildBundle", () => {
  it("packs a tar.gz that tar lists, with the same bytes for the same files", () => {
    const long = `${"a".repeat(80)}/${"b".repeat(80)}/file.txt`;
    const root = project({ "agent.sandbox.ts": "x\n", [long]: "deep\n" });
    const bundle = buildBundle(root);
    expect(bundle.files).toEqual([long, "agent.sandbox.ts"]);
    const out = join(root, "..", `${bundle.sha256}.tar.gz`);
    dirs.push(out);
    writeFileSync(out, bundle.data);
    const listed = execFileSync("tar", ["-tzf", out], { encoding: "utf8" }).trim().split("\n");
    expect(listed.sort()).toEqual([long, "agent.sandbox.ts"].sort());
    expect(buildBundle(root).sha256).toBe(bundle.sha256);
    expect(bundle.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails with a clear message over the size limit", () => {
    const root = project({ "agent.sandbox.ts": "x\n", "big.bin": "z".repeat(10_000) });
    expect(() => buildBundle(root, { maxBytes: 64 })).toThrow(
      /^the bundle is \d+ B \(2 files\), over the limit of 64 B: add the large files to \.gitignore$/,
    );
  });
});
