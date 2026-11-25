import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createVersionSchema, manifestSchema } from "../domain/manifest";

// Copies of the conformance vectors of protocol/sandbox/v1 (ratel-sdk).
const VECTORS = join(import.meta.dirname, "vectors");
const SCHEMAS = { manifest: manifestSchema, "create-version.request": createVersionSchema };

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
