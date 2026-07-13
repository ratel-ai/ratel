import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

describe("published OpenTelemetry dependency layout", () => {
  it("shares the global API while bundling the turnkey SDK implementation", () => {
    expect(manifest.dependencies?.["@opentelemetry/api"]).toBeUndefined();
    expect(manifest.peerDependencies?.["@opentelemetry/api"]).toBe(">=1.3.0 <1.10.0");
    expect(manifest.devDependencies?.["@opentelemetry/api"]).toBeDefined();

    for (const dependency of [
      "@opentelemetry/exporter-trace-otlp-proto",
      "@opentelemetry/resources",
      "@opentelemetry/sdk-trace-base",
      "@opentelemetry/sdk-trace-node",
      "@opentelemetry/semantic-conventions",
    ]) {
      expect(
        manifest.dependencies?.[dependency],
        `${dependency} should install automatically`,
      ).toBeDefined();
    }
  });
});
