import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyHiddenEdit,
  cardState,
  fixPrompt,
  type HealthData,
  type HealthRow,
  hiddenIssuesShown,
  type Issue,
  NO_HIDDEN_EDITS,
  nextFixes,
  rankIssues,
  readingAge,
  readingDone,
  rowMembers,
  rowOfIssue,
  rowsShown,
  STALE_AFTER_MS,
  withHealthScore,
} from "./model";

const issue = (id: string, points: number | null, severity: number): Issue => ({
  id,
  kind: "latency_outlier",
  title: `${id} is slow`,
  claim: "",
  cost: "",
  whatToDo: "Cache it.",
  figure: "",
  caveat: null,
  subject: { kind: "tool", label: id, tools: [{ id, label: id }] },
  severity,
  n: 10,
  hideable: true,
  points,
  href: "",
});

const row = (
  key: string,
  memberIds: string[],
  points: number | null,
  more: Partial<HealthRow> = {},
): HealthRow => ({
  key,
  kind: "latency_outlier",
  title: "Slow tool",
  tone: "watch",
  tools: {
    shown: memberIds.slice(0, 2).map((id) => [id]),
    more: Math.max(0, memberIds.length - 2),
    count: null,
  },
  scope: null,
  about: memberIds.slice(0, 2).join(", "),
  figure: { display: "6.8 s", caption: "median" },
  memberIds,
  points,
  ...more,
});

test("the card lists the console's rows, in the console's order, from the view model", () => {
  const data = {
    issues: [issue("a", null, 0.2), issue("b", null, 0.7), issue("c", null, 0.1)],
    tooEarly: [issue("e", null, 0.05)],
  } as unknown as HealthData;
  // The console's order: most points first, then the ones too early to call.
  const rows = [
    row("slow", ["b", "a"], 7),
    row("retry", ["c"], 2),
    row("early", ["e"], null, { tone: "early" }),
  ];
  const merged = withHealthScore(data, {
    kind: "health_score",
    score: null,
    points: { a: 1, b: 1, c: 2 },
    rows,
    line: "2 issues across 3 tools, most points first.",
  });

  assert.deepEqual(merged.rows, rows, "the rows are the server's, not re-ranked");
  assert.equal(merged.line, "2 issues across 3 tools, most points first.");
  // A row is worth what fixing all of it wins back: more than its issues one at a time.
  assert.equal(merged.rows![0]!.points, 7);
  assert.deepEqual(
    rowMembers(merged.rows![0]!, merged).map((item) => [item.id, item.points]),
    [
      ["b", 1],
      ["a", 1],
    ],
  );
  assert.deepEqual(
    rowMembers(merged.rows![2]!, merged).map((item) => item.id),
    ["e"],
    "a too-early row's issues come from tooEarly",
  );
  assert.equal(rowOfIssue(merged.rows!, "a")?.key, "slow", "an issue opens the row it belongs to");
  assert.equal(rowOfIssue(merged.rows!, "nope"), null);
  assert.equal(rowOfIssue(merged.rows!, null), null);
});

test("an early reading is marked from the view model, with how far it has got", () => {
  const data = { issues: [] } as unknown as HealthData;
  const progress = { read: 40, total: 400, percent: 10 };
  const early = withHealthScore(data, {
    kind: "health_score",
    score: null,
    points: {},
    rows: [],
    line: "",
    early: true,
    progress,
  });
  assert.equal(early.early, true);
  assert.deepEqual(early.progress, progress);
  const full = withHealthScore(data, {
    kind: "health_score",
    score: null,
    points: {},
    rows: [],
    line: "",
  });
  assert.equal(full.early, false);
  assert.equal(full.progress, null);
  assert.equal(withHealthScore(data, undefined).early, false);
});

test("the next fixes are the console's: the first three rows worth a point or more", () => {
  const rows = [
    row("a", ["a"], 7),
    row("b", ["b"], 4),
    row("c", ["c"], 0),
    row("d", ["d"], 2),
    row("e", ["e"], 1),
    row("f", ["f"], null, { tone: "early" }),
  ];
  assert.deepEqual(
    nextFixes(rows).map((item) => item.key),
    ["a", "b", "d"],
  );
  assert.deepEqual(nextFixes([row("c", ["c"], 0)]), []);
});

test("without the view model each issue is a row of its own, worst first", () => {
  const data = { issues: [issue("a", null, 0.2), issue("b", null, 0.7)] } as unknown as HealthData;
  const off = withHealthScore(data, undefined);
  assert.deepEqual(
    off.rows!.map((item) => [item.key, item.memberIds, item.points, item.about]),
    [
      ["b", ["b"], null, "b"],
      ["a", ["a"], null, "a"],
    ],
  );
  assert.equal(off.line, null);
});

test("a row loses the issues just hidden, and goes when none is left", () => {
  const rows = [row("slow", ["a", "b"], 3), row("retry", ["c"], 2)];
  const hideA = applyHiddenEdit(NO_HIDDEN_EDITS, "a", true, issue("a", 1, 0.5));
  assert.deepEqual(
    rowsShown({ rows }, hideA).map((item) => [item.key, item.memberIds]),
    [
      ["slow", ["b"]],
      ["retry", ["c"]],
    ],
  );
  const hideBoth = applyHiddenEdit(hideA, "b", true, issue("b", 1, 0.4));
  assert.deepEqual(
    rowsShown({ rows }, hideBoth).map((item) => item.key),
    ["retry"],
  );
  assert.deepEqual(rowsShown({}, NO_HIDDEN_EDITS), []);
});

test("issues rank by the points fixing them wins back, then by severity", () => {
  const ranked = rankIssues([
    issue("a", 1, 0.9),
    issue("b", 5, 0.1),
    issue("c", 1, 0.95),
    issue("d", null, 0.99),
  ]);
  assert.deepEqual(
    ranked.map((item) => item.id),
    ["b", "c", "a", "d"],
  );
});

test("the score and each issue's points come from the view model, not the agent's data", () => {
  const data = {
    issues: [issue("a", null, 0.2), issue("b", null, 0.7)].map(
      ({ points: _points, ...rest }) => rest,
    ),
  } as unknown as HealthData;
  const score = { value: 81, band: "good" } as unknown as NonNullable<HealthData["score"]>;
  const merged = withHealthScore(data, { kind: "health_score", score, points: { a: 4 } });
  assert.equal(merged.score, score);
  assert.deepEqual(
    merged.issues.map((item) => [item.id, item.points]),
    [
      ["a", 4],
      ["b", null],
    ],
  );
  assert.deepEqual(
    rankIssues(merged.issues).map((item) => item.id),
    ["a", "b"],
  );

  const off = withHealthScore(data, undefined);
  assert.equal(off.score, null);
  assert.ok(off.issues.every((item) => item.points === null));
  assert.equal(
    withHealthScore(data, { kind: "session_chat" }).score,
    null,
    "another view's model is ignored",
  );
});

test("without a score, issues rank by severity", () => {
  assert.deepEqual(
    rankIssues([issue("a", null, 0.2), issue("b", null, 0.7)]).map((item) => item.id),
    ["b", "a"],
  );
});

test("the card's state follows the page's, with one way forward", () => {
  const state = (
    kind: string,
    readiness: "no_telemetry" | "collecting" | "ready" = "ready",
    extra = {},
  ) => cardState({ readiness, state: { kind, title: "T", body: "B", ...extra } });
  assert.deepEqual(state("ready"), { kind: "reading" });
  const setup = state("nothing_yet", "no_telemetry");
  assert.equal(setup.kind === "message" && setup.action, "setup");
  const tooFew = state("too_few", "collecting");
  assert.equal(tooFew.kind === "message" && tooFew.action, "read");
  const stalled = state("building", "ready", { working: false });
  assert.equal(stalled.kind === "message" && stalled.action, "read");
  const working = state("building", "ready", { working: true });
  assert.equal(working.kind === "message" && working.action, null);
  assert.equal(working.kind === "message" && working.working, true);
  const unavailable = state("unavailable");
  assert.equal(unavailable.kind === "message" && unavailable.action, "open");
});

test("a reading older than a day is stale", () => {
  const now = Date.parse("2026-11-11T12:00:00.000Z");
  assert.deepEqual(readingAge(null, now), { text: null, stale: false });
  assert.deepEqual(readingAge("2026-11-11T11:30:00.000Z", now), {
    text: "read 30 min ago",
    stale: false,
  });
  assert.deepEqual(readingAge("2026-11-11T06:00:00.000Z", now), {
    text: "read 6 h ago",
    stale: false,
  });
  assert.equal(readingAge(new Date(now - STALE_AFTER_MS - 60_000).toISOString(), now).stale, true);
  assert.deepEqual(readingAge("2026-11-08T12:00:00.000Z", now), {
    text: "read 3 days ago",
    stale: true,
  });
});

test("a reading is done once nothing is pending and the last one finished after the ask", () => {
  const asked = Date.parse("2026-11-11T12:00:00.000Z");
  const section = (pending: number, lastDoneAt: string | null) => ({
    updatedAt: null,
    working: pending > 0,
    line: null,
    section: { name: "health", pending, lastDoneAt },
  });
  assert.equal(readingDone(section(1, "2026-11-11T12:05:00.000Z"), asked), false);
  assert.equal(readingDone(section(0, "2026-11-11T11:00:00.000Z"), asked), false);
  assert.equal(readingDone(section(0, "2026-11-11T12:05:00.000Z"), asked), true);
  assert.equal(
    readingDone(
      { updatedAt: "2026-11-11T12:01:00.000Z", working: false, line: null, section: null },
      asked,
    ),
    true,
  );
});

test("asking the agent names the issue, its tools and Ratel's suggestion", () => {
  assert.equal(
    fixPrompt(issue("search_orders", 1, 0.4)),
    'Help me fix this Ratel Agent health issue: "search_orders is slow" (search_orders). Ratel suggests: Cache it.',
  );
});

test("hiding an issue again after Show again lists it as hidden, not nowhere", () => {
  const x = issue("x", 3, 0.5);
  const hiddenX = { id: "x", kind: x.kind, toolId: null, label: "x" };
  // The read had x hidden; the user showed it again; the re-read lists it as open.
  let edits = applyHiddenEdit(NO_HIDDEN_EDITS, "x", false);
  assert.deepEqual(
    hiddenIssuesShown({ hiddenIssues: [hiddenX] }, edits),
    [],
    "shown again: off the hidden list at once",
  );
  // Hidden again: on the list now, and after the re-read lists it hidden too.
  edits = applyHiddenEdit(edits, "x", true, x);
  assert.deepEqual(
    hiddenIssuesShown({ hiddenIssues: [] }, edits).map((item) => item.id),
    ["x"],
  );
  assert.deepEqual(
    hiddenIssuesShown({ hiddenIssues: [hiddenX] }, edits).map((item) => item.id),
    ["x"],
    "once, from the read",
  );
});
