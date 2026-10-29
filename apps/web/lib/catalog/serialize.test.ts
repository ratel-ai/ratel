import assert from "node:assert/strict";
import { test } from "node:test";
import type { Skill } from "@/lib/catalog/schema";
import { serializeSkill } from "@/lib/catalog/serialize";

test("serializeSkill maps dates and null publishedAt", () => {
  const createdAt = new Date("2026-01-02T03:04:05.000Z");
  const updatedAt = new Date("2026-01-03T03:04:05.000Z");
  const row = {
    id: "skill-1",
    projectId: "proj-1",
    name: "draft-reply",
    description: "d",
    searchableDescription: null,
    tags: ["a"],
    tools: ["t"],
    metadata: { k: ["v"] },
    body: "body",
    status: "draft",
    version: 2,
    endUserId: null,
    model: null,
    createdAt,
    updatedAt,
    publishedAt: null,
  } as Skill;

  assert.deepEqual(serializeSkill(row), {
    id: "skill-1",
    name: "draft-reply",
    description: "d",
    searchableDescription: null,
    tags: ["a"],
    tools: ["t"],
    metadata: { k: ["v"] },
    body: "body",
    status: "draft",
    version: 2,
    endUserId: null,
    model: null,
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-01-03T03:04:05.000Z",
    publishedAt: null,
  });
});
