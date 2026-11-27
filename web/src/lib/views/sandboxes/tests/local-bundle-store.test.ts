import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bundleStoreContract } from "@/lib/contracts/bundle-store.contract";
import { createLocalBundleStore } from "../adapters/local-bundle-store";

const make = () => createLocalBundleStore(mkdtempSync(join(tmpdir(), "bundles-")));

bundleStoreContract("local disk", make);

test("a key that leaves the folder is refused", async () => {
  await assert.rejects(make().open("../x"), /leaves the folder/);
});
