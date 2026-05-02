import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, resolveRepoPath } from "./paths.js";

describe("paths", () => {
  it("REPO_ROOT contains pnpm-workspace.yaml", () => {
    expect(existsSync(resolve(REPO_ROOT, "pnpm-workspace.yaml"))).toBe(true);
  });

  it("resolves relative paths against the repo root, not cwd", () => {
    expect(resolveRepoPath("benchmark/test-data/metatool.jsonl")).toBe(
      resolve(REPO_ROOT, "benchmark/test-data/metatool.jsonl"),
    );
  });

  it("absolute paths pass through unchanged", () => {
    const abs = "/tmp/some/absolute/path.jsonl";
    expect(resolveRepoPath(abs)).toBe(abs);
    expect(isAbsolute(resolveRepoPath(abs))).toBe(true);
  });
});
