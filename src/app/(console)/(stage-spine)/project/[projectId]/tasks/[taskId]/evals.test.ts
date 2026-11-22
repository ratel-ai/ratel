import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { PROJECT_ID, render, visibleText } from "@/lib/views/tasks/test-support";
import { Evals, type TaskEvalRow } from "./Evals";

const ROOT = `/project/${PROJECT_ID}/traces`;
const rows: TaskEvalRow[] = [
  {
    id: "1",
    turnId: "turn-auto",
    origin: "auto",
    pinned: false,
    excluded: false,
    ask: "Where is the steel delivery?",
    chips: [
      { kind: "max_latency_ms", label: "Run time", status: "fail", score: 0, detail: "4.2 s" },
    ],
    selectionReason: "Fails Run time",
    runHref: `${ROOT}/turns/turn-auto`,
    issueHref: null,
  },
  {
    id: "2",
    turnId: "turn-issue",
    origin: "issue",
    pinned: false,
    excluded: false,
    ask: "Track the switchgear.",
    chips: [],
    selectionReason: "Evidence of: Retries after errors",
    runHref: `${ROOT}/turns/turn-issue`,
    issueHref: `/project/${PROJECT_ID}/health?peek=issue%3Asignal-1`,
  },
  {
    id: "3",
    turnId: "turn-user",
    origin: "user",
    pinned: false,
    excluded: false,
    ask: "Track PO-1177.",
    chips: [],
    selectionReason: "Added by you",
    runHref: `${ROOT}/turns/turn-user`,
    issueHref: null,
  },
  {
    id: "4",
    turnId: "turn-pinned",
    origin: "auto",
    pinned: true,
    excluded: false,
    ask: "Track the joists.",
    chips: [],
    selectionReason: "Fails Tool calls",
    runHref: `${ROOT}/turns/turn-pinned`,
    issueHref: null,
  },
  {
    id: "5",
    turnId: "turn-excluded",
    origin: "user",
    pinned: false,
    excluded: true,
    ask: "Track the roof units.",
    chips: [],
    selectionReason: "Added by you",
    runHref: `${ROOT}/turns/turn-excluded`,
    issueHref: null,
  },
];

function editor(overrides: Partial<Parameters<typeof Evals>[0]> = {}, search = "") {
  return render(
    createElement(Evals, {
      projectId: PROJECT_ID,
      taskId: "task-a",
      rows,
      targetRuns: 20,
      refreshedAt: "2026-11-01T12:00:00Z",
      ...overrides,
    }),
    { search },
  );
}

test("the eval editor shows readable asks, scorer results, ordered groups and one run link per case", () => {
  const html = editor();
  const text = visibleText(html);
  const groups = ["Pinned", "Added by you", "Automatic", "Issue evidence", "Excluded"];
  const headings = [...html.matchAll(/<h3[^>]*>(.*?)<\/h3>/g)].map((match) =>
    visibleText(match[1]!).trim(),
  );
  assert.deepEqual(
    headings,
    groups.map((title) => `${title} (1)`),
  );
  assert.ok(text.includes("4 runs · target 20"));
  assert.ok(text.includes("Last refreshed 2026-11-01"));
  for (const row of rows) {
    assert.ok(text.includes(row.ask));
    assert.ok(text.includes(row.selectionReason));
    assert.equal(html.split(`href="${row.runHref}"`).length - 1, 1);
  }
  assert.ok(html.includes(`href="${rows[1]!.issueHref}"`));
  assert.ok(text.includes("Run time: Fail"));
  assert.equal(html.match(/>Open run<\/a>/g)?.length, 5);
  assert.equal(html.match(/>Unpin<\/button>/g)?.length, 1);
  assert.equal(html.match(/>Pin<\/button>/g)?.length, 3);
  assert.equal(html.match(/>Restore<\/button>/g)?.length, 1);
  assert.doesNotMatch(text, /View trace|max_latency_ms/);
});

test("an empty eval set keeps the add and refresh controls with a first-run message", () => {
  const html = editor({ rows: [], refreshedAt: null });
  const text = visibleText(html);
  for (const label of [
    "No eval runs yet",
    "No refresh yet",
    "No excluded runs.",
    "Refresh eval set",
    "Add run",
  ])
    assert.ok(text.includes(label));
  assert.doesNotMatch(html, /<table/);
});

test("large groups show five rows and preserve expansion in the URL", () => {
  const many = Array.from({ length: 8 }, (_, index) => ({
    ...rows[0]!,
    id: String(index),
    turnId: `turn-${index}`,
    ask: `Delivery ${index}`,
  }));
  const collapsed = editor({ rows: many });
  assert.equal(collapsed.match(/>Open run<\/a>/g)?.length, 5);
  assert.ok(visibleText(collapsed).includes("Show all 8"));
  const expanded = editor({ rows: many }, "evalGroups=auto");
  assert.equal(expanded.match(/>Open run<\/a>/g)?.length, 8);
  assert.ok(visibleText(expanded).includes("Show fewer"));
});

test("the header explains runs above target and refresh progress follows the job", () => {
  assert.ok(
    visibleText(editor({ targetRuns: 2 })).includes(
      "2 pinned or added runs are kept beyond the target.",
    ),
  );
  for (const status of ["queued", "running"] as const) {
    const html = editor({ refreshJob: { id: "job-1", status } });
    assert.ok(visibleText(html).includes("Refreshing…"));
    assert.doesNotMatch(html, /Reload this page after/);
  }
  const finished = visibleText(editor({ refreshJob: { id: "job-1", status: "done" } }));
  assert.doesNotMatch(finished, /Refreshing…/);
  assert.ok(
    visibleText(editor({ refreshJob: { id: "job-1", status: "error" } })).includes(
      "The refresh failed. Try again.",
    ),
  );
});
