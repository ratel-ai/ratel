import assert from "node:assert/strict";
import { test } from "node:test";
import { editionImportRunning } from "./compute-job";

const P = "11111111-1111-4111-8111-111111111111";

test("without an importer, no import is ever running", async () => {
  assert.equal(await editionImportRunning(P, {}), false);
});

test("the edition's importRunning answers first, as upstream's signal run reads it", async () => {
  const asked: string[] = [];
  const edition = {
    importRunning: async (projectId: string) => {
      asked.push(`importRunning:${projectId}`);
      return false;
    },
    runningImport: async () => {
      asked.push("runningImport");
      return { runsImported: 3 };
    },
  };
  assert.equal(await editionImportRunning(P, edition), false);
  assert.deepEqual(asked, [`importRunning:${P}`]);
});

test("an edition with only runningImport marks the reading while it names an import", async () => {
  assert.equal(
    await editionImportRunning(P, { runningImport: async () => ({ runsImported: 0 }) }),
    true,
  );
  assert.equal(await editionImportRunning(P, { runningImport: async () => null }), false);
});
