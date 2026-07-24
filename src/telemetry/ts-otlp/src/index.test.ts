import { describe, expect, it } from "vitest";
import { init, OTLP_ENDPOINT_ENV, startTelemetry } from "./index.js";

describe("@ratel-ai/telemetry-otlp public API", () => {
  it("preserves the endpoint and startTelemetry compatibility exports", () => {
    expect(OTLP_ENDPOINT_ENV).toBe("RATEL_OTLP_ENDPOINT");
    expect(init).toBe(startTelemetry);
  });
});
