import assert from "node:assert/strict";
import { test } from "node:test";
import type { Skill } from "@/lib/catalog/schema";
import {
  BODY_PREVIEW_CHARS,
  capRows,
  summarizeSkill,
  TruncationTracker,
  truncateText,
} from "./serialize";

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "skill-1",
    projectId: "project-1",
    name: "explain-error",
    description: "Explains an error",
    searchableDescription: null,
    body: "x".repeat(2_000),
    tags: [],
    tools: [],
    metadata: {},
    status: "published",
    version: 3,
    endUserId: null,
    model: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    publishedAt: new Date("2026-01-03T00:00:00.000Z"),
    ...overrides,
  } as Skill;
}

test("capRows reports truncation only when rows were dropped", () => {
  assert.deepEqual(capRows([1, 2], 5), { rows: [1, 2], truncated: false });
  assert.deepEqual(capRows([1, 2, 3], 2), { rows: [1, 2], truncated: true });
});

test("truncateText marks and shortens over-long prose", () => {
  const result = truncateText("y".repeat(BODY_PREVIEW_CHARS + 10));

  assert.equal(result.truncated, true);
  assert.equal(result.text.length, BODY_PREVIEW_CHARS + 1, "keeps the ellipsis");
});

test("a skill summary previews the body instead of returning kilobytes", () => {
  const summary = summarizeSkill(skill());

  assert.equal(summary.bodyTruncated, true);
  assert.equal(summary.bodyChars, 2_000);
  assert.ok(summary.bodyPreview.length < 2_000);
  assert.equal(summary.name, "explain-error");
});

test("a short body is returned whole and not marked truncated", () => {
  const summary = summarizeSkill(skill({ body: "short" }));

  assert.equal(summary.bodyTruncated, false);
  assert.equal(summary.bodyPreview, "short");
});

test("the tracker latches truncation across parts of one result", () => {
  const tracker = new TruncationTracker();

  tracker.take(capRows([1, 2], 5));
  assert.equal(tracker.value, false);

  tracker.take(capRows([1, 2, 3], 1));
  assert.equal(tracker.value, true);
});
