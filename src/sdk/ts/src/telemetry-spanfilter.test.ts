import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * configureTelemetry (the high-level SDK path) must default to the `ratel.*`/`gen_ai.*`
 * signal filter and require `exportAllSpans` to forward everything (RS-15). The filter
 * lives inside init()'s provider, which never exports in-process — so we mock the OTLP
 * peer and assert exactly what configureTelemetry hands to init(). The real
 * `ratelSignalFilter` is kept (via importActual) so its behavior is under test too.
 */
const captured = vi.hoisted(() => ({
  initOptions: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@ratel-ai/telemetry-otlp", async (importActual) => {
  const actual = await importActual<typeof import("@ratel-ai/telemetry-otlp")>();
  return {
    ...actual,
    init: vi.fn((opts: Record<string, unknown>) => {
      captured.initOptions = opts;
      return { shutdown: async () => {} };
    }),
  };
});

import { configureTelemetry } from "./index.js";

const ENDPOINT = "http://localhost:4318/v1/traces";

// Minimal ReadableSpan stand-in: the filter only reads `name` + `attributes`.
function fakeSpan(name: string, attributes: Record<string, unknown>): never {
  return { name, attributes } as never;
}

afterEach(() => {
  captured.initOptions = undefined;
});

describe("configureTelemetry default span filtering (RS-15)", () => {
  it("defaults to the ratel/gen_ai signal filter, dropping unrelated app spans", async () => {
    await configureTelemetry({ endpoint: ENDPOINT });

    const filter = captured.initOptions?.spanFilter as ((s: never) => boolean) | undefined;
    expect(filter, "configureTelemetry passes a default spanFilter to init()").toBeTruthy();
    if (!filter) return;
    expect(filter(fakeSpan("ratel.search", {}))).toBe(true);
    expect(filter(fakeSpan("execute_tool x", { "gen_ai.operation.name": "execute_tool" }))).toBe(
      true,
    );
    // An unrelated framework/HTTP span carries no gen_ai/ratel signal -> dropped.
    expect(filter(fakeSpan("GET /api", { "http.method": "GET" }))).toBe(false);
  });

  it("forwards every span when exportAllSpans is true (init()'s accept-all default)", async () => {
    await configureTelemetry({ endpoint: ENDPOINT, exportAllSpans: true });
    expect(captured.initOptions?.spanFilter).toBeUndefined();
  });
});
