import assert from "node:assert/strict";
import { test } from "node:test";
import { createDrizzleCaseStore } from "../adapters/drizzle-case-store";
import { createDrizzleDatasetStore } from "../adapters/drizzle-dataset-store";
import { currentVersion } from "../domain/case";
import { createEvalsDb, OTHER_PROJECT_ID, PROJECT_ID } from "./support";

const NOW = new Date("2026-11-27T10:00:00Z");

async function fixedWithRows() {
  const { db } = await createEvalsDb();
  const datasets = createDrizzleDatasetStore(db);
  const made = await datasets.create({
    projectId: PROJECT_ID,
    name: "Refund asks",
    description: null,
    query: { kind: "fixed" },
    createdBy: "user_1",
  });
  if (made === "name_taken") throw new Error("taken");
  const rows = await datasets.addRows(
    PROJECT_ID,
    made.id,
    [
      { kind: "values", name: "One", row: { values: { order: "A1" }, expectedOutput: null } },
      { kind: "values", name: "Two", row: { values: { order: "A2" }, expectedOutput: null } },
    ],
    "user_1",
  );
  if (!Array.isArray(rows)) throw new Error(rows);
  return { db, datasets, dataset: made, rows };
}

test("a removed row leaves the dataset and its count, and keeps its versions", async () => {
  const { db, datasets, dataset, rows } = await fixedWithRows();
  const [one] = rows;
  assert.ok(one);
  assert.equal(await datasets.removeRow(PROJECT_ID, dataset.id, one.id, NOW), "removed");
  const left = await datasets.rows(PROJECT_ID, dataset.id);
  assert.deepEqual(
    left.map(({ name }) => name),
    ["Two"],
  );
  const [summary] = await datasets.list(PROJECT_ID);
  assert.equal(summary?.rowCount, 1);
  assert.ok(summary && summary.updatedAt.getTime() === NOW.getTime());
  // A run that froze the row still reads its version.
  const kept = await createDrizzleCaseStore(db).get(PROJECT_ID, one.id);
  assert.equal(kept && currentVersion(kept)?.number, 1);
  assert.deepEqual(
    (await createDrizzleCaseStore(db).list(PROJECT_ID)).map(({ name }) => name),
    ["Two"],
  );
  // Removed one time: a second removal finds nothing.
  assert.equal(await datasets.removeRow(PROJECT_ID, dataset.id, one.id, NOW), "not_found");
});

test("a row of another project or another dataset is not found", async () => {
  const { datasets, dataset, rows } = await fixedWithRows();
  const [one] = rows;
  assert.ok(one);
  assert.equal(await datasets.removeRow(OTHER_PROJECT_ID, dataset.id, one.id, NOW), "not_found");
  const other = await datasets.create({
    projectId: PROJECT_ID,
    name: "Other",
    description: null,
    query: { kind: "fixed" },
    createdBy: "user_1",
  });
  if (other === "name_taken") throw new Error("taken");
  assert.equal(await datasets.removeRow(PROJECT_ID, other.id, one.id, NOW), "not_found");
  assert.equal((await datasets.rows(PROJECT_ID, dataset.id)).length, 2);
});

test("a query dataset has no row to remove", async () => {
  const { datasets } = await fixedWithRows();
  const query = await datasets.create({
    projectId: PROJECT_ID,
    name: "Last traces",
    description: null,
    query: { kind: "last_traces", limit: 20 },
    createdBy: "user_1",
  });
  if (query === "name_taken") throw new Error("taken");
  assert.equal(
    await datasets.removeRow(PROJECT_ID, query.id, "a1111111-1111-4111-8111-111111111111", NOW),
    "not_fixed",
  );
});
