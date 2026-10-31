import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { RunMenu, WindowMenu } from "@/components/console/quality/HeaderControls";
import type { RunMenuModel } from "./run-menu";
import { ROOT, render } from "./test-support";

/**
 * Quality's Suggestions moved to Fixes (`components/fixes/v2`), which lists
 * them with every other fix and reuses this panel body for a rewrite.
 */
const MENU: RunMenuModel = {
  live: false,
  label: "Analyse searches",
  status: "Analysed 3 days ago",
  windows: [{ days: 7, label: "Last 7 days", detail: "312 searches", disabled: false }],
  budget: "3 runs left this month",
  nextRun: "Next automatic run in 4 days",
};

test("the header menus: the run menu is a trigger until a run is live", () => {
  const idle = render(createElement(RunMenu, { projectId: "p1", model: MENU }));
  assert.match(idle, /<button[^>]*aria-haspopup="menu"[^>]*>Analyse searches/);
  const live = render(
    createElement(RunMenu, {
      projectId: "p1",
      model: { ...MENU, live: true, label: "Analysing…" },
    }),
  );
  assert.match(
    live,
    /<button(?=[^>]*aria-disabled="true")(?=[^>]*aria-busy="true")[^>]*>[\s\S]*Analysing…<\/button>/,
  );
  assert.doesNotMatch(live, /aria-haspopup/, "nothing to open while a run is live");
  assert.match(live, /role="status"[^>]*>Analysing your searches</);
  const window = render(
    createElement(WindowMenu, {
      label: "Last 7 days",
      options: [{ id: "7d", label: "Last 7 days", href: `${ROOT}/quality`, active: true }],
    }),
  );
  assert.match(window, /aria-label="Time window: Last 7 days"/);
});
