import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import { buildManifest, resolveParams, type Sandbox, sandbox } from "./index.js";
import sumSandbox from "./test-support/sum-project/sum.sandbox.js";

const SCHEMA_DIR = fileURLToPath(
  new URL("../../../../protocol/sandbox/v1/schema", import.meta.url),
);

function manifestValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
  (addFormatsModule as unknown as (a: Ajv2020) => void)(ajv);
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".schema.json")) ajv.addSchema(JSON.parse(readFileSync(p, "utf8")));
    }
  };
  walk(SCHEMA_DIR);
  const validate = ajv.getSchema("https://ratel.sh/protocol/sandbox/v1/manifest.schema.json");
  if (!validate) throw new Error("no manifest schema");
  return validate;
}

const plain = (extra: Record<string, unknown> = {}) =>
  sandbox("plain", {
    params: { scale: sandbox.number(1) },
    input: sandbox.structured<{ n: number }>({ type: "object" }),
    run: ({ input, params }) => input.n * params.scale,
    ...extra,
  });

describe("sandbox.image", () => {
  it("fills the defaults: copy the project root, nothing else", () => {
    expect(sandbox.image({ base: "node:22-slim" })).toEqual({
      base: "node:22-slim",
      install: [],
      copy: ["."],
      sidecars: [],
      env: [],
    });
  });

  it("keeps the sidecars and normalizes the paths", () => {
    const image = sandbox.image({
      base: "node:22-slim",
      install: ["pnpm install --frozen-lockfile"],
      copy: ["./src/", "package.json"],
      sidecars: [sandbox.postgres({ version: "16", seed: "./db/seed.sql" }), sandbox.redis()],
      env: ["AWS_REGION"],
    });
    expect(image.copy).toEqual(["src", "package.json"]);
    expect(image.sidecars).toEqual([
      { kind: "postgres", version: "16", seed: "db/seed.sql" },
      { kind: "redis" },
    ]);
  });

  it("rejects an env entry with a value, and never echoes the value", () => {
    const attempt = () =>
      sandbox.image({ base: "node:22-slim", env: ["AWS_REGION", "API_KEY=sk-live-123"] });
    expect(attempt).toThrow(
      /env "API_KEY=…" holds a value: env lists names only, the values come from the project secrets/,
    );
    expect(attempt).not.toThrow(/sk-live-123/);
  });

  it("rejects an env entry that is not a var name", () => {
    expect(() => sandbox.image({ base: "node:22-slim", env: ["aws region"] })).toThrow(
      /env "aws region" is not an env var name/,
    );
  });

  it.each([
    ["../secrets", /copy "..\/secrets" leaves the project root/],
    ["src/../../etc", /copy "src\/..\/..\/etc" leaves the project root/],
    ["/etc/passwd", /copy "\/etc\/passwd" is absolute/],
    ["C:\\Users", /copy "C:\\Users" is absolute/],
  ])("rejects the copy path %s", (path, message) => {
    expect(() => sandbox.image({ base: "node:22-slim", copy: [path] })).toThrow(message);
  });

  it("rejects a seed outside the project root", () => {
    expect(() => sandbox.postgres({ seed: "../seed.sql" })).toThrow(
      /sandbox.postgres: seed "..\/seed.sql" leaves the project root/,
    );
  });

  it("rejects an empty base, a bad version and a sidecar declared twice", () => {
    expect(() => sandbox.image({ base: " " })).toThrow(/base must be a container image/);
    expect(() => sandbox.redis({ version: "latest" })).toThrow(/is not a version number/);
    expect(() =>
      sandbox.image({ base: "node:22-slim", sidecars: [sandbox.redis(), sandbox.redis()] }),
    ).toThrow(/redis is declared twice/);
  });
});

describe("sandbox output and state", () => {
  it("rejects an unknown state and a hand-built image with a value in env", () => {
    expect(() => plain({ state: "forever" })).toThrow(/plain: state must be "run" or "session"/);
    expect(() =>
      plain({
        image: { base: "node:22", install: [], copy: ["."], sidecars: [], env: ["A=b"] },
      }),
    ).toThrow(/plain: image: env "A=…" holds a value/);
  });

  it("rejects an output that is not from sandbox.output() or sandbox.text()", () => {
    expect(() => plain({ output: { kind: "json" } })).toThrow(/plain: output must come from/);
  });
});

describe("manifest of a hosted sandbox", () => {
  const validate = manifestValidator();

  it("carries image, output and state, and validates against protocol/sandbox/v1", () => {
    const manifest = buildManifest({
      sandboxes: [{ sandbox: sumSandbox, file: "sum.sandbox.ts" }],
    });
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(manifest.sandboxes[0]).toMatchObject({
      id: "sum-numbers",
      state: "run",
      output: { kind: "structured", schema: { required: ["total"] } },
      image: {
        base: "node:22-slim",
        install: ["npm install"],
        copy: ["."],
        sidecars: [{ kind: "postgres", version: "16", seed: "db/seed.sql" }, { kind: "redis" }],
        env: ["SUM_REGION"],
      },
    });
  });

  it("defaults state to run and leaves image and output out when not declared", () => {
    const manifest = buildManifest({ sandboxes: [{ sandbox: plain() }] });
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(manifest.sandboxes[0]?.state).toBe("run");
    expect(manifest.sandboxes[0]).not.toHaveProperty("image");
    expect(manifest.sandboxes[0]).not.toHaveProperty("output");
  });

  it("validates a session sandbox with a text output", () => {
    const chatty = plain({ state: "session", output: sandbox.text() });
    const manifest = buildManifest({ sandboxes: [{ sandbox: chatty }] });
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(manifest.sandboxes[0]).toMatchObject({ state: "session", output: { kind: "text" } });
  });
});

describe("config hash", () => {
  it("covers the resolved param values only: image, output and state do not change it", () => {
    const hashOf = (s: Sandbox) => resolveParams(s, { scale: 2 }).configHash;
    const hosted = plain({
      state: "session",
      output: sandbox.text(),
      image: sandbox.image({ base: "node:22-slim", env: ["AWS_REGION"] }),
    });
    expect(hashOf(hosted as Sandbox)).toBe(hashOf(plain() as Sandbox));
  });
});
