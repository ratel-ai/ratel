import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBundle, bundleFiles, type GitRunner } from "./bundle.js";

// The bundle of `ratel sandbox push`, on throwaway projects: with git (its file
// list, minus .gitignore) and without (a walk). Both always drop .env files,
// dependencies, .git and build output.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string | undefined>): string {
  const root = mkdtempSync(join(tmpdir(), "ratel-bundle-"));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    if (content === undefined) continue;
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
    expect(bundleFiles(root)).toEqual({
      source: "git",
      files: [".gitignore", "agent.sandbox.ts", "db/seed.sql", "src/agent.ts"],
    });
  });

  it("outside git: applies the .gitignore files, minus the always-excluded (replaces the old 'every file' walk)", () => {
    const root = project(FILES);
    expect(bundleFiles(root)).toEqual({
      source: "gitignore",
      files: [".gitignore", "agent.sandbox.ts", "db/seed.sql", "src/agent.ts"],
    });
  });

  it("outside git: honors nested .gitignore files and negations as git does", () => {
    const root = project({
      "agent.sandbox.ts": "x\n",
      ".gitignore": "*.log\n!keep.log\nsecrets/\n/build-cache\n",
      "app.log": "ignored\n",
      "keep.log": "re-included by the negation\n",
      "secrets/key.pem": "ignored dir\n",
      "build-cache": "ignored at the root only\n",
      "src/build-cache": "kept: the pattern is anchored to the root\n",
      "src/.gitignore": "local.json\n!important.log\n",
      "src/local.json": "ignored by the nested file\n",
      "src/important.log": "re-included by the nested negation\n",
      "src/debug.log": "ignored by the root pattern\n",
      "src/deep/local.json": "ignored: nested patterns match below their folder\n",
      "src/deep/main.ts": "kept\n",
    });
    expect(bundleFiles(root)).toEqual({
      source: "gitignore",
      files: [
        ".gitignore",
        "agent.sandbox.ts",
        "keep.log",
        "src/.gitignore",
        "src/build-cache",
        "src/deep/main.ts",
        "src/important.log",
      ],
    });
  });

  it("never bundles a regular file named .git, .env files or node_modules, in or out of git", () => {
    const files = {
      "agent.sandbox.ts": "x\n",
      "sub/.git": "gitdir: /elsewhere\n",
      "sub/.env.production": "X=1\n",
      "sub/node_modules/a.js": "1\n",
    };
    expect(bundleFiles(project(files))).toEqual({
      source: "gitignore",
      files: ["agent.sandbox.ts"],
    });
    const inGit = project(files);
    git(inGit, "init", "-q");
    expect(bundleFiles(inGit)).toEqual({ source: "git", files: ["agent.sandbox.ts"] });
    // A .git file at the root that points nowhere: git fails, so push is refused.
    const broken = project({ ...files, ".git": "gitdir: /elsewhere\n" });
    expect(() => bundleFiles(broken)).toThrow(/push refused/);
  });

  it("refuses when git cannot list the files of a work tree, and never falls back to a walk", () => {
    const root = project(FILES);
    const failing: GitRunner = (args) => {
      if (args[0] === "rev-parse") return "true\n";
      throw Object.assign(new Error("Command failed: git ls-files"), {
        status: 128,
        stderr: "fatal: index file corrupt\n",
      });
    };
    expect(() => bundleFiles(root, { git: failing })).toThrow(
      /^git cannot list the project files \(fatal: index file corrupt\): push refused, so no file outside the \.gitignore rules is uploaded$/,
    );
  });

  it("treats a missing git as outside a work tree and applies the .gitignore files", () => {
    const missing: GitRunner = () => {
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    };
    expect(bundleFiles(project(FILES), { git: missing }).source).toBe("gitignore");
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
