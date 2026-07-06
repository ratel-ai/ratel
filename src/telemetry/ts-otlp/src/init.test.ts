import { ENDPOINT_ENV } from "@ratel-ai/telemetry";
import { describe, expect, it } from "vitest";
import { init } from "./init.js";

describe("init", () => {
  it("returns a handle with a shutdown function", async () => {
    const handle = init({
      apiKey: "k",
      endpoint: "http://localhost:4318/v1/traces",
      serviceName: "test",
    });
    expect(typeof handle.shutdown).toBe("function");
    // Best-effort cleanup: the export target is absent in unit tests, so the
    // handle shape (not shutdown's network resolution) is the contract asserted.
    await handle.shutdown().catch(() => {});
  });

  it("throws on misconfiguration (no endpoint, no RATEL_URL)", () => {
    const saved = process.env[ENDPOINT_ENV];
    delete process.env[ENDPOINT_ENV];
    try {
      expect(() => init({ apiKey: "k" })).toThrow(ENDPOINT_ENV);
    } finally {
      if (saved === undefined) {
        delete process.env[ENDPOINT_ENV];
      } else {
        process.env[ENDPOINT_ENV] = saved;
      }
    }
  });
});
