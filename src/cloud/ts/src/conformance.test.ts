import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Event } from "./index.js";
import { validate } from "./index.js";

// The same fixtures the Rust spec and Python client run against — the
// cross-language contract (ADR-0013).
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures");

function load(kind: "valid" | "invalid"): Array<{ name: string; event: Event }> {
  const dir = join(fixturesDir, kind);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  expect(files.length).toBeGreaterThan(0);
  return files.map((name) => ({ name, event: JSON.parse(readFileSync(join(dir, name), "utf8")) }));
}

describe("conformance", () => {
  it.each(load("valid"))("accepts valid fixture $name", ({ event }) => {
    expect(validate(event)).toEqual({ ok: true });
  });

  it.each(load("invalid"))("rejects invalid fixture $name", ({ event }) => {
    expect(validate(event).ok).toBe(false);
  });
});
