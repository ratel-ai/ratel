import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createVersionSchema, ratelYamlSchema, secretNameSchema } from "../domain/config";
import { errorSchema, runResponseSchema } from "../domain/contract";
import { runRequestSchema, sandboxRunSchema, startRunRequestSchema } from "../domain/run";

// Copies of the conformance vectors of protocol/sandbox/v1 (ratel-sdk).
const VECTORS = join(import.meta.dirname, "vectors");
const SCHEMAS = {
  "ratel-yaml": ratelYamlSchema,
  "create-version.request": createVersionSchema,
  "run-response": runResponseSchema,
  error: errorSchema,
  "run-request": runRequestSchema,
  "start-run.request": startRunRequestSchema,
  "sandbox-run": sandboxRunSchema,
};

for (const kind of ["valid", "invalid"] as const) {
  for (const [prefix, schema] of Object.entries(SCHEMAS)) {
    const files = readdirSync(join(VECTORS, kind)).filter((file) => file.startsWith(`${prefix}.`));
    test(`${kind} vectors of ${prefix}`, () => {
      assert.ok(files.length > 0);
      for (const file of files) {
        const body = JSON.parse(readFileSync(join(VECTORS, kind, file), "utf8"));
        assert.equal(schema.safeParse(body).success, kind === "valid", file);
      }
    });
  }
}

test("the refusal of a reserved secret name has no name of a provider", () => {
  for (const name of ["RATEL_URL", "BOAT_API_KEY", "AWS_REGION"]) {
    const refusal = secretNameSchema.safeParse(name);
    assert.ok(!refusal.success);
    assert.equal(
      refusal.error.issues[0]?.message,
      "The prefix of this name is reserved. Use another name.",
    );
  }
});

test("an enum default that is not an option is refused at its path", () => {
  const refusal = ratelYamlSchema.safeParse({
    name: "a",
    input: { example: 1 },
    params: { model: { type: "enum", options: ["x"], default: "y" } },
  });
  assert.ok(!refusal.success);
  assert.deepEqual(refusal.error.issues[0]?.path, ["params", "model", "default"]);
});

test("a configuration with a NUL character is refused: Postgres cannot store it", () => {
  const body = JSON.parse(
    readFileSync(join(VECTORS, "valid", "create-version.request.full.json"), "utf8"),
  );
  body.config.input.example = "a\0b";
  assert.equal(createVersionSchema.safeParse(body).success, false);
});
