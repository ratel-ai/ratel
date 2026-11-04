import assert from "node:assert/strict";
import { test } from "node:test";
import { ANALYSIS_SECTIONS, isAnalysisSection } from "./sections";

test("only known sections are accepted from a URL", () => {
  assert.equal(isAnalysisSection("intents"), true);
  assert.equal(isAnalysisSection("toString"), false);
  assert.equal(isAnalysisSection(""), false);
  assert.equal(isAnalysisSection(null), false);
});

test("no page waits on turn builds or on work a person watches in place", () => {
  const excluded = [
    "build_trace_turns",
    "simulate_fix_eval",
    "simulate_task_eval",
    "what_if_step",
    "refresh_task_eval_set",
    "run_import",
  ];
  for (const [section, kinds] of Object.entries(ANALYSIS_SECTIONS)) {
    for (const kind of excluded)
      assert.ok(!(kinds as readonly string[]).includes(kind), `${section} lists ${kind}`);
  }
});
