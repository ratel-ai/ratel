import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import { buildManifest, callableProviders, SDK_VERSION, type StructuredInput } from "./index.js";
import { labelSandbox } from "./test-support/label.sandbox.js";

const SCHEMA_DIR = fileURLToPath(
  new URL("../../../../protocol/sandbox/v1/schema", import.meta.url),
);

function validator() {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictTypes: false,
    strictRequired: false,
  });
  (addFormatsModule as unknown as (a: Ajv2020) => void)(ajv);
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".schema.json")) ajv.addSchema(JSON.parse(readFileSync(p, "utf8")));
    }
  };
  walk(SCHEMA_DIR);
  return ajv.getSchema("https://ratel.sh/protocol/sandbox/v1/manifest.schema.json");
}

describe("buildManifest", () => {
  const manifest = buildManifest({
    sandboxes: [{ sandbox: labelSandbox, file: "src/label.sandbox.ts" }],
    build: { id: "3f9a1c2e", dirty: true },
    env: { ANTHROPIC_API_KEY: "sk-secret", OPENAI_API_KEY: "" },
  });

  it("validates against protocol/sandbox/v1", () => {
    const validate = validator();
    expect(validate?.(manifest), JSON.stringify(validate?.errors)).toBe(true);
  });

  it("lists the params in order with their kind, default and constraints", () => {
    expect(manifest.sandboxes[0]).toEqual({
      id: "workflow-label",
      file: "src/label.sandbox.ts",
      modelResolver: "builtin",
      input: {
        kind: "structured",
        schema: (labelSandbox.input as StructuredInput<unknown>).schema,
      },
      state: "run",
      params: [
        {
          name: "model",
          kind: "model",
          default: "anthropic/claude-sonnet-5-5",
          source: "declared",
        },
        {
          name: "system",
          kind: "prompt",
          default: "You name agent workflows.",
          source: "declared",
        },
        {
          name: "maxTokens",
          kind: "scalar",
          type: "int",
          default: 400,
          min: 50,
          max: 2000,
          source: "declared",
        },
      ],
      context: [],
    });
  });

  it("names callable providers by key name and never by value", () => {
    expect(manifest.providers).toEqual([{ provider: "anthropic", keys: ["ANTHROPIC_API_KEY"] }]);
    expect(JSON.stringify(manifest)).not.toContain("sk-secret");
  });

  it("carries the SDK name and version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(SDK_VERSION).toBe(pkg.version);
    expect(manifest.sdk).toEqual({
      language: "typescript",
      name: "@ratel-ai/sandbox",
      version: pkg.version,
    });
  });
});

describe("callableProviders", () => {
  it("returns the providers whose key is set", () => {
    expect(callableProviders({ AI_GATEWAY_API_KEY: "x", ANTHROPIC_API_KEY: "y" })).toEqual([
      { provider: "anthropic", keys: ["ANTHROPIC_API_KEY"] },
      { provider: "gateway", keys: ["AI_GATEWAY_API_KEY"] },
    ]);
  });
});
