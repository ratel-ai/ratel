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

describe("published vercel-ai-sdk dependency layout", () => {
  it("carries no runtime dependencies — the adapter is pure glue", () => {
    // Everything the adapter touches (`ai`, `@ratel-ai/sdk`) is the host's to
    // provide, so it ships as peers with zero runtime `dependencies`.
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it("peers on AI SDK 5–7 and the workspace SDK", () => {
    expect(manifest.peerDependencies?.ai).toBe("^5.0.0 || ^6.0.0 || ^7.0.0");
    expect(manifest.peerDependencies?.["@ratel-ai/sdk"]).toBe("workspace:^");
  });

  it("dev-pins the exact AI SDK release selected for this verification run", () => {
    // CI replaces this exact dev version per matrix row. The environment keeps
    // the assertion exact without hard-wiring every row to the default v7 pin.
    expect(manifest.devDependencies?.ai).toBe(process.env.AI_SDK_VERSION ?? "7.0.33");
    expect(manifest.devDependencies?.["@ratel-ai/sdk"]).toBe("workspace:^");
  });

  it("publishes public with provenance under MIT", () => {
    expect(manifest.private).toBe(false);
    expect(manifest.license).toBe("MIT");
    expect(manifest.publishConfig?.access).toBe("public");
    expect(manifest.publishConfig?.provenance).toBe(true);
  });
});
