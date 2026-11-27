import assert from "node:assert/strict";
import { test } from "node:test";
import { scrollToReveal, widgetToReveal } from "@/components/console/home/focused/edit-mode";
import { changeLayout, DEFAULT_LAYOUT } from "@/lib/views/overview-layout/domain/layout";

test("the last added widget that is still on the page is the one to reveal", () => {
  assert.equal(widgetToReveal([], DEFAULT_LAYOUT), null);
  assert.equal(widgetToReveal(["health", "topology"], DEFAULT_LAYOUT), "topology");
  const without = changeLayout(DEFAULT_LAYOUT, { kind: "remove", widget: "topology" });
  assert.equal(widgetToReveal(["topology"], without), null, "removed again, or rolled back");
  assert.equal(widgetToReveal(["health", "topology"], without), "health");
});

test("nothing scrolls for a widget that is whole in the view", () => {
  const view = { top: 80, bottom: 900 };
  assert.equal(scrollToReveal({ top: 80, bottom: 900 }, view), 0);
  assert.equal(scrollToReveal({ top: 700, bottom: 1000 }, view), 100, "below");
  assert.equal(scrollToReveal({ top: 20, bottom: 300 }, view), -60, "above");
  assert.equal(scrollToReveal({ top: 500, bottom: 2000 }, view), 420, "taller: its top");
});
