import assert from "node:assert/strict";
import { test } from "node:test";
import type { HealthShareLink } from "@/lib/contracts/composition";
import { shareLinkOnPlan } from "@/lib/views/health/share-window";

const LINK: HealthShareLink = {
  token: "tok",
  windowDays: 90,
  createdAt: "2026-11-01T00:00:00.000Z",
  viewCount: 3,
  lastViewedAt: null,
};

test("the share dialog shows the link's window cut to the plan as it is now", () => {
  assert.equal(
    shareLinkOnPlan(LINK, 7)?.windowDays,
    7,
    "a 90-day link after a downgrade to 7 days",
  );
  assert.equal(
    shareLinkOnPlan({ ...LINK, windowDays: 30 }, 90)?.windowDays,
    30,
    "within the plan: as stored",
  );
  assert.equal(shareLinkOnPlan({ ...LINK, windowDays: 30 }, 7)?.windowDays, 7);
});

test("the rest of the link is kept, and no link stays no link", () => {
  const { windowDays: _cut, ...rest } = shareLinkOnPlan(LINK, 30) ?? LINK;
  const { windowDays: _stored, ...stored } = LINK;
  assert.deepEqual(rest, stored);
  assert.equal(shareLinkOnPlan(null, 30), null);
});
