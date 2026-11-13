import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnoseEngine } from "@/lib/readings/intent-engine/diagnose";
import { VerbLexicon } from "@/lib/readings/intent-engine/text";

test("diagnosis counts singletons, mixed-action intents, multi-action members and splits", () => {
  const clusters = [
    { uuid: "cr", members: ["create task", "create a task in project"] },
    { uuid: "cm", members: ["add comment on task"] },
    { uuid: "ls", members: ["list tasks", "create task comment on task list tasks in project"] },
    { uuid: "ck", members: ["check the CI tests"] },
  ];
  const nodes = [
    { uuid: "l1-mixed", level: 1, children: ["cr", "cm"] },
    { uuid: "l1-list", level: 1, children: ["ls"] },
    { uuid: "l1-ci", level: 1, children: ["ck"] },
    { uuid: "l2", level: 2, children: ["l1-mixed", "l1-list"] },
  ];
  const assignments = [
    { eventId: "e1", askIndex: 0 },
    { eventId: "e2", askIndex: 0 },
    { eventId: "e2", askIndex: 1 },
    { eventId: "e3", askIndex: 0 },
  ];
  const d = diagnoseEngine(clusters, nodes, assignments, new VerbLexicon());
  assert.equal(d.clusters, 4);
  assert.equal(d.singletonShare0, 0.5);
  assert.equal(d.intents, 3, "only level 1 counts as intents");
  assert.equal(d.singletonShare1, 2 / 3);
  assert.deepEqual(d.mixedActionIntents, [{ uuid: "l1-mixed", verbs: ["add", "create"] }]);
  assert.equal(d.members, 6);
  assert.equal(d.multiActionMembers, 1);
  assert.equal(d.asks, 3);
  assert.equal(d.splitShare, 1 / 3);
});

test("an empty project diagnoses to zeros", () => {
  const d = diagnoseEngine([], [], [], new VerbLexicon());
  assert.equal(d.singletonShare0, 0);
  assert.equal(d.splitShare, 0);
  assert.deepEqual(d.mixedActionIntents, []);
});
