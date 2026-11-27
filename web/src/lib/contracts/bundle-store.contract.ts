import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import type { BundleStore } from "./bundle-store";

const BODY = Buffer.from("a bundle");
const info = (body: Buffer) => ({
  sha256: createHash("sha256").update(body).digest("hex"),
  bytes: body.length,
});

/** What every adapter of the bundle store must do. Imported by the test of each adapter. */
export function bundleStoreContract(label: string, make: () => BundleStore | Promise<BundleStore>) {
  describe(`bundle store contract: ${label}`, () => {
    test("a stored bundle reads back", async () => {
      const store = await make();
      assert.equal(await store.open("p1/v1"), null);
      assert.deepEqual(await store.put("p1/v1", chunks(BODY), info(BODY)), { ok: true });
      assert.deepEqual(await readAll(store, "p1/v1"), BODY);
    });

    test("a stored bundle is never replaced", async () => {
      const store = await make();
      await store.put("p1/v1", chunks(BODY), info(BODY));
      const other = Buffer.from("other");
      assert.deepEqual(await store.put("p1/v1", chunks(other), info(other)), {
        ok: false,
        reason: "exists",
      });
      assert.deepEqual(await readAll(store, "p1/v1"), BODY);
    });

    test("a body that is not the announced bundle is not stored", async () => {
      const store = await make();
      const mismatch = { ok: false, reason: "mismatch" };
      const longer = Buffer.concat([BODY, Buffer.from("!")]);
      const changed = Buffer.from("A bundle");
      for (const body of [longer, changed, BODY.subarray(1)]) {
        assert.deepEqual(await store.put("p1/v2", chunks(body), info(BODY)), mismatch);
        assert.equal(await store.open("p1/v2"), null);
      }
    });
  });
}

async function* chunks(body: Buffer): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < body.length; i += 3) yield body.subarray(i, i + 3);
}

async function readAll(store: BundleStore, key: string): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const part of (await store.open(key)) ?? []) parts.push(part);
  return Buffer.concat(parts);
}
