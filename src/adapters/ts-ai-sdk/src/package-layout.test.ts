import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  private?: boolean;
  license?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  publishConfig?: { access?: string; provenance?: boolean };
}

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

describe("published ai-sdk-adapter dependency layout", () => {
  it("carries no runtime dependencies — the adapter is pure glue", () => {
    // Everything the adapter touches (`ai`, `@ratel-ai/sdk`) is the host's to
    // provide, so it ships as peers with zero runtime `dependencies`.
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it("peers on ai@^7 and the workspace SDK", () => {
    expect(manifest.peerDependencies?.ai).toBe("^7.0.0");
    expect(manifest.peerDependencies?.["@ratel-ai/sdk"]).toBe("workspace:^");
  });

  it("dev-pins ai to the live-verified release and the workspace SDK", () => {
    // A pinned dev `ai` (not a range) keeps the type-tests honest against the
    // exact release the adapter was verified on; the workspace SDK satisfies
    // its own peer locally and forces the topological build edge.
    expect(manifest.devDependencies?.ai).toBe("7.0.26");
    expect(manifest.devDependencies?.["@ratel-ai/sdk"]).toBe("workspace:^");
  });

  it("publishes public with provenance under MIT", () => {
    expect(manifest.private).toBe(false);
    expect(manifest.license).toBe("MIT");
    expect(manifest.publishConfig?.access).toBe("public");
    expect(manifest.publishConfig?.provenance).toBe(true);
  });
});
