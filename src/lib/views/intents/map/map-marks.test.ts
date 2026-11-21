import assert from "node:assert/strict";
import { test } from "node:test";
import { pointInPolygon, polygonsMeet } from "@/lib/views/intents/map/map-blobs";
import {
  computeMarkedLayout,
  markId,
  markModel,
  markOrder,
  toolMarks,
} from "@/lib/views/intents/map/map-marks";
import type { IntentMapModel } from "@/lib/views/intents/map/map-model";

const ask = (id: string, volume: number) => ({
  id,
  label: `Intent ${id}`,
  volume,
  phrasings: 1,
  firstTry: null,
  rankedByGraph: 0,
  problem: null,
});
const tool = (name: string, calls: number, asks: number) => ({
  id: `tool:${name}`,
  kind: "tool" as const,
  name,
  calls,
  asks,
  missing: false,
});
const link = (askId: string, name: string, weight: number) => ({
  ask: askId,
  capability: `tool:${name}`,
  weight,
  share: 0,
});

// Five intents that all lean on `schedule`: a Venn could not hold it; each blob holds its own mark of it.
function model(): IntentMapModel {
  return {
    asks: [
      ask("status", 258),
      ask("delivery", 225),
      ask("orders", 172),
      ask("inspect", 45),
      ask("rental", 47),
    ],
    capabilities: [
      tool("schedule", 305, 5),
      tool("track", 233, 2),
      tool("weather", 120, 2),
      tool("estimate", 166, 1),
      tool("checklist", 39, 1),
    ],
    links: [
      link("status", "schedule", 243),
      link("status", "weather", 118),
      link("status", "track", 5),
      link("delivery", "track", 224),
      link("delivery", "schedule", 13),
      link("orders", "estimate", 161),
      link("orders", "schedule", 13),
      link("inspect", "checklist", 39),
      link("inspect", "schedule", 6),
      link("inspect", "weather", 2),
      link("rental", "schedule", 30),
    ],
    hidden: null,
  };
}

test("every intent holds a mark of each tool its asks used; a tool in several intents is marked shared in each", () => {
  const marks = toolMarks(model());
  assert.equal(marks.marks.length, 11, "one mark per intent and tool");
  assert.deepEqual(
    marks.byAsk.get("status")!.map((mark) => [mark.id, mark.weight, mark.shared]),
    [
      ["tool:schedule@status", 243, true],
      ["tool:weather@status", 118, true],
      ["tool:track@status", 5, true],
    ],
    "busiest first",
  );
  assert.deepEqual(
    marks.byAsk.get("orders")!.find((mark) => mark.capability === "tool:estimate")!.shared,
    false,
    "a tool one intent uses is its own",
  );
  assert.deepEqual(
    marks.byCapability.get("tool:schedule")!.map((mark) => mark.ask),
    ["status", "rental", "delivery", "orders", "inspect"],
    "a tool's marks, its busiest intent first",
  );
  assert.equal(markId("tool:schedule", "status"), "tool:schedule@status");
  assert.deepEqual(
    markOrder(model(), marks).slice(0, 5),
    ["status", "tool:schedule@status", "tool:weather@status", "tool:track@status", "delivery"],
    "the keyboard walks an intent, then its tools",
  );
});

test("the layout model places each mark as a tool of its own intent, sized by its calls there", () => {
  const source = model();
  const placed = markModel(source, toolMarks(source));
  assert.equal(placed.capabilities.length, 11);
  assert.ok(placed.capabilities.every((capability) => capability.asks === 1));
  assert.deepEqual(
    placed.capabilities.find((capability) => capability.id === "tool:schedule@rental"),
    { ...tool("schedule", 30, 1), id: "tool:schedule@rental" },
  );
  assert.ok(placed.links.every((item) => item.capability.endsWith(`@${item.ask}`)));
});

test("every mark sits inside its own blob, blobs never overlap, and the drawing is the same every time", () => {
  const first = computeMarkedLayout(model(), { width: 1100, height: 600 });
  for (const mark of first.marks.marks) {
    const node = first.layout.nodes.get(mark.id)!;
    const blob = first.layout.groups.get(mark.ask)!.blob;
    assert.ok(pointInPolygon(node, blob.points), `${mark.id} is inside its intent`);
    for (const [other, group] of first.layout.groups) {
      if (other !== mark.ask)
        assert.ok(!pointInPolygon(node, group.blob.points), `${mark.id} is not inside ${other}`);
    }
  }
  const groups = [...first.layout.groups.values()];
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1)
      assert.ok(!polygonsMeet(groups[i]!.blob.points, groups[j]!.blob.points), "blobs keep apart");
  }
  const again = computeMarkedLayout(model(), { width: 1100, height: 600 });
  assert.deepEqual(
    [...again.layout.nodes].map(([id, node]) => [id, node.x, node.y]),
    [...first.layout.nodes].map(([id, node]) => [id, node.x, node.y]),
  );
});
