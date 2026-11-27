// RTL-368: the pieces that keep fast scrubbing from taking the session replay down.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { clockTime } from "@/components/console/session-chat/format";
import { PanelBoundary } from "@/components/console/session-replay/PanelBoundary";

test("clockTime keeps its HH:MM in UTC with one shared formatter", () => {
  assert.equal(clockTime("2026-10-30T15:55:41Z"), "15:55");
  assert.equal(clockTime("2026-10-30T00:05:00+02:00"), "22:05");
});

test("PanelBoundary renders its panel while nothing failed", () => {
  const html = renderToStaticMarkup(
    createElement(PanelBoundary, { name: "step inspector", resetKey: "s:3" }, "the panel"),
  );
  assert.equal(html, "the panel");
});

test("PanelBoundary catches a panel's error and shows a note in its place", () => {
  const state = PanelBoundary.getDerivedStateFromError(new Error("boom"));
  assert.equal(state.error?.message, "boom");
  const boundary = new PanelBoundary({ name: "What if… panel", resetKey: 7 });
  boundary.state = { error: new Error("boom"), key: 7 };
  const html = renderToStaticMarkup(boundary.render() as ReactElement);
  assert.match(html, /The What if… panel could not be shown/);
  assert.match(html, /The rest of the replay still works/);
});

test("PanelBoundary tries the panel again on the next step, not on the same one", () => {
  const failed = { error: new Error("boom"), key: "s:3" as string | number | null | undefined };
  assert.equal(PanelBoundary.getDerivedStateFromProps({ resetKey: "s:3" }, failed), null);
  assert.deepEqual(PanelBoundary.getDerivedStateFromProps({ resetKey: "s:4" }, failed), {
    error: null,
    key: "s:4",
  });
});
