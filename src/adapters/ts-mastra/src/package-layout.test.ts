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

describe("published mastra dependency layout", () => {
  it("carries no runtime dependencies — the adapter is pure glue", () => {
    // Everything the adapter touches (`@mastra/core`, `zod`, `@ratel-ai/sdk`) is
    // the host's to provide, so it ships as peers with zero runtime `dependencies`.
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it("peers on @mastra/core@^1.51, zod (matching Mastra's range), and the workspace SDK", () => {
    expect(manifest.peerDependencies?.["@mastra/core"]).toBe("^1.51.0");
    // zod is a runtime peer (unlike the AI SDK adapter): the exposed capability
    // tools carry hand-written zod schemas. The range matches @mastra/core's own
    // zod peer so a Mastra app on zod 3.25.x resolves cleanly.
    expect(manifest.peerDependencies?.zod).toBe("^3.25.0 || ^4.0.0");
    expect(manifest.peerDependencies?.["@ratel-ai/sdk"]).toBe("workspace:^");
  });

  it("dev-pins @mastra/core to the live-verified release and the workspace SDK", () => {
    // A pinned dev `@mastra/core` (not a range) keeps the codecs + type-tests
    // honest against the exact release the adapter was verified on; the workspace
    // SDK satisfies its own peer locally and forces the topological build edge.
    expect(manifest.devDependencies?.["@mastra/core"]).toBe("1.51.0");
    expect(manifest.devDependencies?.["@ratel-ai/sdk"]).toBe("workspace:^");
  });

  it("publishes public with provenance under MIT", () => {
    expect(manifest.private).toBe(false);
    expect(manifest.license).toBe("MIT");
    expect(manifest.publishConfig?.access).toBe("public");
    expect(manifest.publishConfig?.provenance).toBe(true);
  });
});
