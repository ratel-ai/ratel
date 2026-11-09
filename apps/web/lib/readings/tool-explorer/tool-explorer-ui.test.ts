import assert from "node:assert/strict";
import { test } from "node:test";
import { intentToolsView, parseScope } from "@/lib/readings/tool-explorer/view";

/**
 * The tool reading's URL parsing and its ask view (what a drafted fix serves).
 * Drafted fixes are rendered on Fixes (`lib/fixes/fixes-view.test.ts`).
 */

const INTENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const INTENT_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const intentRow = (intentId: string, text: string, units: number, toolId: string, n: number) => ({
  scope: "turn" as const,
  intentId,
  intentText: text,
  intentUnits: units,
  toolId,
  n,
  share: n / units,
  shareLow: Math.max(0, n / units - 0.15),
});

test("URL state parses with safe defaults", () => {
  assert.equal(parseScope(undefined), "turn");
  assert.equal(parseScope("session"), "session");
  assert.equal(parseScope(["session", "turn"]), "session");
  assert.equal(parseScope("anything"), "turn");
});

test("intentToolsView groups rows per intent, biggest first, tools by share, and names the lexical group", () => {
  const view = intentToolsView(
    [
      intentRow(INTENT_B, "weekly report", 10, "report", 10),
      intentRow(INTENT_A, "hand a task to someone", 40, "find", 40),
      intentRow(INTENT_A, "hand a task to someone", 40, "assign", 36),
    ],
    [
      { id: "g1", label: "task hand someone", intentIds: [INTENT_A, "other"] },
      { id: "g2", label: "weekly report", intentIds: [INTENT_B] },
    ],
  );
  assert.deepEqual(
    view.map((v) => [v.intentId, v.units, v.groupLabel, v.tools.map((t) => t.toolId)]),
    [
      [INTENT_A, 40, "task hand someone", ["find", "assign"]],
      [INTENT_B, 10, null, ["report"]],
    ],
  );
});
