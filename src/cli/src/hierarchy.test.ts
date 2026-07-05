import { describe, expect, it } from "vitest";
import { findProjectRoot, ProjectRootNotFoundError, ratelConfigPath } from "./hierarchy.js";

const HOME = "/home/u";

function fakeFs(present: ReadonlySet<string>) {
  return { existsSync: (p: string) => present.has(p) };
}

describe("ratelConfigPath", () => {
  it("resolves global to <home>/.ratel/config.json", () => {
    expect(ratelConfigPath("user", { homeDir: HOME })).toBe("/home/u/.ratel/config.json");
  });

  it("resolves project to <root>/.ratel/config.json", () => {
    expect(ratelConfigPath("project", { homeDir: HOME, projectRoot: "/r" })).toBe(
      "/r/.ratel/config.json",
    );
  });

  it("resolves local to <root>/.ratel/config.local.json", () => {
    expect(ratelConfigPath("local", { homeDir: HOME, projectRoot: "/r" })).toBe(
      "/r/.ratel/config.local.json",
    );
  });

  it.each([
    "project",
    "local",
  ] as const)("throws when %s is requested without a project root", (s) => {
    expect(() => ratelConfigPath(s, { homeDir: HOME })).toThrow(ProjectRootNotFoundError);
  });
});

describe("findProjectRoot", () => {
  it("finds the directory containing pnpm-workspace.yaml", () => {
    const fs = fakeFs(new Set(["/r/pnpm-workspace.yaml"]));
    expect(findProjectRoot("/r/sub/deep", fs)).toBe("/r");
  });

  it("finds the directory containing .git", () => {
    const fs = fakeFs(new Set(["/r/.git"]));
    expect(findProjectRoot("/r/sub", fs)).toBe("/r");
  });

  it("finds the directory containing package.json", () => {
    const fs = fakeFs(new Set(["/r/package.json"]));
    expect(findProjectRoot("/r", fs)).toBe("/r");
  });

  it("finds the directory containing .mcp.json", () => {
    const fs = fakeFs(new Set(["/r/.mcp.json"]));
    expect(findProjectRoot("/r", fs)).toBe("/r");
  });

  it("prefers a workspace marker over a nested package marker", () => {
    const fs = fakeFs(new Set(["/r/pnpm-workspace.yaml", "/r/sub/package.json"]));
    expect(findProjectRoot("/r/sub", fs)).toBe("/r");
  });

  it("walks up from a deep subdir until a marker is found", () => {
    const fs = fakeFs(new Set(["/r/.git"]));
    expect(findProjectRoot("/r/a/b/c/d", fs)).toBe("/r");
  });

  it("throws ProjectRootNotFoundError when no marker is reachable", () => {
    const fs = fakeFs(new Set());
    expect(() => findProjectRoot("/some/where", fs)).toThrow(ProjectRootNotFoundError);
  });

  it("returns the start dir when the marker is right there", () => {
    const fs = fakeFs(new Set(["/r/.git"]));
    expect(findProjectRoot("/r", fs)).toBe("/r");
  });
});
