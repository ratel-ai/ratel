import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { PROJECT_ID, render, visibleText } from "@/lib/views/tasks/test-support";
import { ScoreChart } from "./ScoreChart";
import { Scorers } from "./Scorers";

test("task settings and the score legend call ends_well Finishes cleanly", () => {
  const settings = visibleText(
    render(
      createElement(Scorers, {
        projectId: PROJECT_ID,
        taskId: "task-a",
        scorers: [{ kind: "ends_well", enabled: true, source: "default", version: 1 }],
      }),
    ),
  );
  assert.ok(settings.includes("Finishes cleanly"));
  assert.ok(settings.includes("The last tool call succeeded and the agent replied."));
  const chart = visibleText(
    render(
      createElement(ScoreChart, {
        today: "2026-11-01",
        rows: [
          { day: "2026-11-01", scorerKind: "ends_well", n: 10, passed: 8 },
          { day: "2026-11-01", scorerKind: "overall", n: 10, passed: 8 },
        ],
      }),
    ),
  );
  assert.ok(chart.includes("Finishes cleanly"));
  assert.doesNotMatch(`${settings} ${chart}`, /Ends well/);
});

test("task criteria are editable and the score series is marked sampled", () => {
  const settings = render(
    createElement(Scorers, {
      projectId: PROJECT_ID,
      taskId: "task-a",
      scorers: [
        {
          kind: "judge_criteria",
          criteria: "Find the order.",
          enabled: true,
          source: "user",
          version: 1,
        },
      ],
    }),
  );
  assert.match(settings, /<textarea[^>]*>Find the order\.<\/textarea>/);
  const chart = visibleText(
    render(
      createElement(ScoreChart, {
        today: "2026-11-01",
        rows: [
          { day: "2026-11-01", scorerKind: "overall", n: 100, passed: 80 },
          { day: "2026-11-01", scorerKind: "judge_criteria", n: 20, passed: 15 },
        ],
      }),
      { search: "scoreScorer=judge_criteria&scoreView=table" },
    ),
  );
  assert.match(chart, /Task criteria \(sampled\)/);
  assert.match(chart, /75%/);
  assert.match(chart, /20/);
});
