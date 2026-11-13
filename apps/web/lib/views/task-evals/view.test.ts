import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECK_LABELS } from "@/lib/views/eval-gate/types";
import { FINISHES_CLEANLY_HELP, SCORER_LABELS } from "@/lib/views/task-scorers/labels";
import { taskEvalRow } from "./view";

const CASE = {
  id: "case-1",
  turnId: "turn-1",
  origin: "auto" as const,
  pinned: false,
  excludedAt: null,
  selectionReason: "ends_well: pass, max_latency_ms: fail",
};

test("an eval row shows the first user ask, scorer chips and a readable failure reason", () => {
  const row = taskEvalRow({
    projectId: "project-1",
    case: CASE,
    messages: [
      { role: "system", content: "Help with deliveries." },
      { role: "user", parts: [{ type: "text", content: "Track PO-26-1177." }] },
      { role: "user", content: "Any updates?" },
    ],
    results: [
      { kind: "ends_well", status: "pass", score: 1, detail: "ends well" },
      { kind: "max_latency_ms", status: "fail", score: 0, detail: "4.2 s" },
    ],
  });
  assert.equal(row.ask, "Track PO-26-1177.");
  assert.deepEqual(
    row.chips.map(({ label, status }) => [label, status]),
    [
      ["Finishes cleanly", "pass"],
      ["Run time", "fail"],
    ],
  );
  assert.equal(row.selectionReason, "Fails Run time");
  assert.equal(row.runHref, "/project/project-1/traces/turns/turn-1");
  assert.equal(SCORER_LABELS.ends_well, "Finishes cleanly");
  assert.equal(CHECK_LABELS.ends_well, "Finishes cleanly");
  assert.equal(FINISHES_CLEANLY_HELP, "The last tool call succeeded and the agent replied.");
});

test("issue evidence names and links the issue without showing its stored reason", () => {
  const row = taskEvalRow({
    projectId: "project-1",
    case: { ...CASE, origin: "issue", selectionReason: "Evidence of issue signal-1." },
    messages: [{ role: "user", content: "Where is the steel?" }],
    results: [],
    issue: { id: "signal-1", title: "Repeats a failed call" },
  });
  assert.equal(row.selectionReason, "Evidence of: Repeats a failed call");
  assert.equal(row.issueHref, "/project/project-1/health?peek=issue%3Asignal-1");
});

test("missing content and unmeasured scorers stay explicit and user additions keep their reason", () => {
  const missing = taskEvalRow({
    projectId: "project-1",
    case: CASE,
    messages: [],
    results: [{ kind: "ends_well", status: "skip", score: 0, detail: "not measured" }],
  });
  assert.equal(missing.ask, "Ask not captured");
  assert.equal(missing.chips[0]!.status, "skip");
  assert.equal(missing.selectionReason, "Scorer results not measured");
  const user = taskEvalRow({
    projectId: "project-1",
    case: { ...CASE, origin: "user" },
    messages: [],
    results: [],
  });
  assert.equal(user.selectionReason, "Added by you");
  const mixed = taskEvalRow({
    projectId: "project-1",
    case: CASE,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Track " },
          { type: "image", url: "private" },
          { type: "text", text: "PO-1177" },
        ],
      },
    ],
    results: [
      { kind: "ends_well", status: "pass", score: 1, detail: "ends well" },
      { kind: "max_latency_ms", status: "skip", score: 0, detail: "not measured" },
    ],
  });
  assert.equal(mixed.ask, "Track  PO-1177");
  assert.equal(mixed.selectionReason, "Passes measured scorers");
  assert.equal(
    taskEvalRow({ projectId: "project-1", case: CASE, messages: [], results: [] }).selectionReason,
    "No enabled scorers",
  );
});

test("a captured turn ask remains visible when model messages contain no user text", () => {
  const row = taskEvalRow({
    projectId: "project-1",
    case: CASE,
    messages: [{ role: "assistant", content: "Done." }],
    fallbackAsk: "Track the joists.",
    results: [],
  });
  assert.equal(row.ask, "Track the joists.");
});

test("a user test shows its edited name and ask", () => {
  const row = taskEvalRow({
    projectId: "project-1",
    case: {
      ...CASE,
      origin: "user",
      testName: "Track a late delivery",
      testAsk: "Where is the steel?",
    },
    messages: [{ role: "user", content: "Original ask" }],
    results: [],
  });
  assert.equal(row.name, "Track a late delivery");
  assert.equal(row.ask, "Where is the steel?");
});
