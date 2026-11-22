import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canAddWidget,
  canEditDashboard,
  canOpenDashboard,
  canShareDashboard,
  moveWidget,
  validateDashboardName,
  WIDGET_LIMIT,
} from "./model";

/** RC-888: who opens and edits a dashboard, its name, the widget limit and the order. */

test("the creator opens and edits a private dashboard; another member does neither", () => {
  const mine = { createdBy: "user_a", sharing: "private" as const };
  assert.equal(canOpenDashboard(mine, "user_a"), true);
  assert.equal(canEditDashboard(mine, "user_a"), true);
  assert.equal(canOpenDashboard(mine, "user_b"), false);
  assert.equal(canEditDashboard(mine, "user_b"), false);
});

test("every member opens and edits a project dashboard", () => {
  const shared = { createdBy: "user_a", sharing: "project" as const };
  assert.equal(canEditDashboard(shared, "user_a"), true);
  assert.equal(canOpenDashboard(shared, "user_b"), true);
  assert.equal(canEditDashboard(shared, "user_b"), true);
});

test("only the creator changes who sees a dashboard, private or shared", () => {
  for (const sharing of ["private", "project"] as const) {
    const dashboard = { createdBy: "user_a", sharing };
    assert.equal(canShareDashboard(dashboard, "user_a"), true, sharing);
    assert.equal(canShareDashboard(dashboard, "user_b"), false, sharing);
  }
});

test("a caller with no person (a project API key) opens only project dashboards and edits none", () => {
  assert.equal(canOpenDashboard({ createdBy: "user_a", sharing: "project" }, null), true);
  assert.equal(canOpenDashboard({ createdBy: "user_a", sharing: "private" }, null), false);
  assert.equal(canShareDashboard({ createdBy: "user_a" }, null), false);
});

test("a dashboard takes widgets up to the limit of 20", () => {
  assert.equal(WIDGET_LIMIT, 20);
  assert.equal(canAddWidget(0), true);
  assert.equal(canAddWidget(19), true);
  assert.equal(canAddWidget(20), false);
});

test("a name is 1 to 80 characters once trimmed", () => {
  assert.deepEqual(validateDashboardName("  Client   costs "), { ok: true, value: "Client costs" });
  assert.deepEqual(validateDashboardName(""), { ok: false });
  assert.deepEqual(validateDashboardName("   "), { ok: false });
  assert.deepEqual(validateDashboardName("x".repeat(81)), { ok: false });
  assert.deepEqual(validateDashboardName(42), { ok: false });
});

test("a widget moves one place up or down, not past either end", () => {
  const widgets = [
    { id: "b", position: 1 },
    { id: "a", position: 0 },
    { id: "c", position: 2 },
  ];
  assert.deepEqual(moveWidget(widgets, "b", "up"), ["b", "a", "c"]);
  assert.deepEqual(moveWidget(widgets, "b", "down"), ["a", "c", "b"]);
  assert.equal(moveWidget(widgets, "a", "up"), null);
  assert.equal(moveWidget(widgets, "c", "down"), null);
  assert.equal(moveWidget(widgets, "z", "up"), null);
});
