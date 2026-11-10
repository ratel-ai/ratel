import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IMPORTED_SOURCE_IDS,
  isImportedSourceId,
  registerImportedSourceIds,
} from "@/lib/ledger/constants";

test("an import is an exact source id: one that only ends in -import is live telemetry", () => {
  for (const id of ["langfuse-import", "langsmith-import", "postgres-import"]) {
    assert.equal(isImportedSourceId(id), true, id);
  }
  for (const id of ["csv-import", "my-agent-import", "-import", "LANGFUSE-IMPORT", "", null]) {
    assert.equal(isImportedSourceId(id), false, String(id));
  }
  assert.equal(isImportedSourceId(undefined), false);
});

test("an importer's registered ids count as imports, in the one set every reader shares", () => {
  assert.equal(isImportedSourceId("acme-import"), false);
  registerImportedSourceIds(["acme-import", "langfuse-import"]);
  assert.equal(isImportedSourceId("acme-import"), true);
  assert.equal(isImportedSourceId("acme-import "), false);
  assert.deepEqual([...IMPORTED_SOURCE_IDS].sort(), [
    "acme-import",
    "langfuse-import",
    "langsmith-import",
    "postgres-import",
  ]);
});
