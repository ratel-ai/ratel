import { describe, expect, it } from "vitest";
import { OTLP_ENDPOINT_ENV } from "./index.js";

describe("@ratel-ai/telemetry-otlp public API", () => {
  it("exports the OTLP endpoint env var", () => {
    expect(OTLP_ENDPOINT_ENV).toBe("RATEL_OTLP_ENDPOINT");
  });
});
