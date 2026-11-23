import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixes } from "@/lib/views/fixes/build";
import {
  type RecordFixShipmentDeps,
  type RecordFixShipmentInput,
  recordFixShipment,
  shipmentFields,
} from "@/lib/views/fixes/record-shipment";
import type { FixShipmentRow } from "@/lib/views/fixes/schema";
import { fixesInput } from "@/lib/views/fixes/test-fixtures";

const PROJECT = "p1";
const fix = buildFixes(fixesInput()).open[0]!;

function setup(over: Partial<RecordFixShipmentInput> = {}) {
  const links: { object: { kind: string; id: string }; source: { kind: string; id: string } }[] =
    [];
  const events: { name: string; properties: Record<string, unknown> }[] = [];
  const created: unknown[] = [];
  const deps: RecordFixShipmentDeps = {
    createFixShipment: async (input): Promise<FixShipmentRow> => {
      created.push(input);
      return {
        id: "ship-1",
        liveMarkedBy: null,
        ...input,
        shippedAt: new Date("2026-11-01T00:00:00Z"),
      };
    },
    recordLineage: async (input) => {
      links.push(input);
      return input.object;
    },
    trackServerEvent: (async (
      name: string,
      _context: unknown,
      properties: Record<string, unknown>,
    ) => {
      events.push({ name, properties });
    }) as RecordFixShipmentDeps["trackServerEvent"],
  };
  const input: RecordFixShipmentInput = {
    projectId: PROJECT,
    fix,
    experiment: null,
    version: "v1.0.0",
    notes: null,
    shippedBy: "user_1",
    actor: { externalId: "user_1", projectId: PROJECT },
    surface: "fixes",
    ...over,
  };
  return { deps, input, links, events, created };
}

test("a shipment is stored, then linked to the fix and the fix to its source", async () => {
  const { deps, input, links, created } = setup();
  const { row } = await recordFixShipment(input, deps);
  assert.equal(row.id, "ship-1");
  assert.equal((created[0] as { fixId: string }).fixId, fix.id);
  assert.deepEqual(links.map((link) => [link.object.kind, link.source.kind]).at(-1), [
    "shipment",
    "fix",
  ]);
  assert.equal(links.at(-1)!.object.id, "ship-1");
  assert.equal(links.at(-1)!.source.id, fix.id);
});

test("an experiment becomes the source of the shipment", async () => {
  const { deps, input, links } = setup({ experiment: { id: "e1", name: "fix-exp-1" } });
  await recordFixShipment(input, deps);
  assert.deepEqual(
    [links.at(-1)!.source.kind, links.at(-1)!.source.id],
    ["experiment", "fix-exp-1"],
  );
});

test("fix_shipped carries the surface it came from", async () => {
  for (const surface of ["fixes", "mcp"] as const) {
    const { deps, input, events } = setup({ surface });
    await recordFixShipment(input, deps);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.name, "fix_shipped");
    assert.equal(events[0]!.properties.surface, surface);
    assert.equal(events[0]!.properties.shipment_id, "ship-1");
    assert.equal(events[0]!.properties.has_experiment, false);
  }
});

test("a failed lineage link after the insert still returns the stored shipment and emits fix_shipped, for MCP too", async () => {
  const { deps, input, events, created } = setup({ surface: "mcp" });
  deps.recordLineage = async () => {
    throw new Error("lineage down");
  };
  const { row } = await recordFixShipment(input, deps);
  assert.equal(row.id, "ship-1");
  assert.equal(created.length, 1);
  assert.deepEqual(
    events.map((event) => [event.name, event.properties.surface, event.properties.shipment_id]),
    [["fix_shipped", "mcp", "ship-1"]],
  );
});

test("a failed insert stores nothing, links nothing and emits nothing", async () => {
  const { deps, input, events, links } = setup();
  deps.createFixShipment = async () => {
    throw new Error("db down");
  };
  await assert.rejects(recordFixShipment(input, deps), /db down/);
  assert.equal(links.length, 0);
  assert.equal(events.length, 0);
});

test("shipment fields: version is 1 to 100 trimmed characters, notes at most 1000", () => {
  assert.equal(shipmentFields.safeParse({ version: "  v2  " }).data?.version, "v2");
  assert.equal(shipmentFields.safeParse({ version: "   " }).success, false);
  assert.equal(shipmentFields.safeParse({ version: "" }).success, false);
  assert.equal(shipmentFields.safeParse({ version: "v".repeat(100) }).success, true);
  assert.equal(shipmentFields.safeParse({ version: "v".repeat(101) }).success, false);
  assert.equal(shipmentFields.safeParse({ version: "v1", notes: "n".repeat(1000) }).success, true);
  assert.equal(shipmentFields.safeParse({ version: "v1", notes: "n".repeat(1001) }).success, false);
});
