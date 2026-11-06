import assert from "node:assert/strict";
import { test } from "node:test";
import { PROJECT_ID, setupDb } from "@/lib/readings/trace-signals/signals/integration-support";
import {
  type CreateFixShipmentInput,
  createFixShipment,
  listProjectShipments,
} from "./loop-queries";
import { fixSeams } from "./seams";
import { shippedByFix } from "./shipped";

const shipment = (over: Partial<CreateFixShipmentInput> = {}): CreateFixShipmentInput => ({
  projectId: PROJECT_ID,
  fixId: "issue:44444444-4444-4444-8444-444444444444",
  insightId: null,
  experimentId: null,
  version: "v2.5.0",
  notes: null,
  shippedBy: "system:test",
  ...over,
});

test("a shipment is one row, and the project's shipments say which fixes shipped", async () => {
  const { client, db } = await setupDb();
  try {
    const first = await createFixShipment(shipment(), db);
    assert.equal(first.version, "v2.5.0");
    assert.equal(first.liveMarkedBy, null);
    await createFixShipment(shipment({ fixId: "craft:55555555-5555-4555-8555-555555555555" }), db);

    const rows = await listProjectShipments(PROJECT_ID, db);
    assert.equal(rows.length, 2);
    const shipped = shippedByFix(PROJECT_ID, rows);
    assert.equal(shipped[first.fixId]?.shipmentId, first.id);
    assert.deepEqual(
      await listProjectShipments("99999999-9999-4999-8999-999999999999", db),
      [],
      "another project sees nothing",
    );
  } finally {
    await client.close();
  }
});

test("a filled recordShipment seam writes the shipment instead", async () => {
  const { client, db } = await setupDb();
  const seen: string[] = [];
  fixSeams.recordShipment = async (input, write) => {
    seen.push(input.fixId);
    return write({ ...input, liveMarkedBy: input.shippedBy });
  };
  try {
    const row = await createFixShipment(shipment(), db);
    assert.deepEqual(seen, [row.fixId]);
    assert.equal(row.liveMarkedBy, "system:test");
  } finally {
    delete fixSeams.recordShipment;
    await client.close();
  }
});
