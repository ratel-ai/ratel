import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createVersionSchema, manifestSchema, secretNameSchema } from "../domain/manifest";
import { runResultSchema } from "../domain/run";

// Copies of the conformance vectors of protocol/sandbox/v1 (ratel-sdk).
const VECTORS = join(import.meta.dirname, "vectors");
const SCHEMAS = {
  manifest: manifestSchema,
  "create-version.request": createVersionSchema,
  "run-result": runResultSchema,
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
