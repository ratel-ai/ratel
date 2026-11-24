import assert from "node:assert/strict";
import { test } from "node:test";
import { hallucinationsLinks } from "@/lib/views/health/hallucinations/page-links";
import {
  buildHallucinationsPage,
  KIND_EXAMPLES,
  type PageFinding,
  uncheckedReason,
} from "@/lib/views/health/hallucinations/page-model";
import {
  hallucinationsHref,
  parseHallucinationsQuery,
} from "@/lib/views/health/hallucinations/paths";
import { turnMarkers } from "@/lib/views/health/hallucinations/turn-markers";

let n = 0;
function finding(over: Partial<PageFinding> = {}): PageFinding {
  n += 1;
  return {
    id: `f-${String(n).padStart(4, "0")}`,
    turnId: `turn-${n}`,
    sessionId: `s-${n}`,
    stepOrdinal: 1,
    eventId: `event-${n}`,
    kind: "tool_rerouted",
    toolId: "entity_lookup",
    requestedToolId: "get_task",
    repeats: 1,
    worked: true,
    occurredAt: new Date(Date.parse("2026-09-01T10:00:00Z") + n * 60_000),
    ...over,
  };
}

const page = (
  findings: PageFinding[],
  over: { turns?: number; lastReadAt?: Date | null; group?: string; kind?: string } = {},
) =>
  buildHallucinationsPage(
    {
      projectId: "p1",
      windowDays: 30,
      findings,
      turns: over.turns ?? 100,
      lastReadAt:
        over.lastReadAt === undefined ? new Date("2026-09-02T00:00:00Z") : over.lastReadAt,
      capped: false,
    },
    parseHallucinationsQuery({
      ...(over.group ? { group: over.group } : {}),
      ...(over.kind ? { kind: over.kind } : {}),
    }),
  );

test("the rate is turns with a finding of the window's turns; shares are of every occurrence", () => {
  const twice = finding();
  const model = page(
    [
      twice,
      finding({
        turnId: twice.turnId,
        sessionId: twice.sessionId,
        kind: "unknown_reference",
        requestedToolId: null,
        toolId: "update_task",
        worked: false,
      }),
      finding(),
      finding({
        kind: "claimed_done_after_failure",
        requestedToolId: null,
        toolId: "add_task_comment",
        worked: false,
      }),
    ],
    { turns: 60 },
  );
  assert.deepEqual(model.totals, { turns: 60, turnsAffected: 3, rate: 0.05, occurrences: 4 });
  assert.deepEqual(
    model.groups.map((group) => [
      group.group,
      group.occurrences,
      group.share,
      group.kinds.map((kind) => [kind.kind, kind.occurrences, kind.share]),
    ]),
    [
      ["tool", 2, 0.5, [["tool_rerouted", 2, 0.5]]],
      ["input", 1, 0.25, [["unknown_reference", 1, 0.25]]],
      ["completion", 1, 0.25, [["claimed_done_after_failure", 1, 0.25]]],
    ],
  );
  assert.equal(model.state, "ready");
});

test("a kind lists its tools (asked for and ran, with how many worked) and its newest occurrences", () => {
  const findings = [
    ...Array.from({ length: KIND_EXAMPLES + 2 }, () => finding()),
    finding({ toolId: "create_task", requestedToolId: "create_tasks", worked: false, repeats: 3 }),
  ];
  const kind = page(findings).groups[0]!.kinds[0]!;
  assert.deepEqual(kind.tools, [
    {
      toolId: "entity_lookup",
      requestedToolId: "get_task",
      occurrences: KIND_EXAMPLES + 2,
      worked: KIND_EXAMPLES + 2,
    },
    { toolId: "create_task", requestedToolId: "create_tasks", occurrences: 1, worked: 0 },
  ]);
  assert.equal(kind.calls, KIND_EXAMPLES + 2 + 3, "tries count as calls, not as occurrences");
  assert.equal(kind.examples.length, KIND_EXAMPLES);
  assert.equal(kind.examples[0]!.turnId, findings.at(-1)!.turnId, "newest first");
});

test("the states: never read, no turns, and read with nothing found", () => {
  assert.equal(page([], { lastReadAt: null }).state, "not_read");
  assert.equal(page([], { turns: 0 }).state, "empty");
  const clean = page([]);
  assert.deepEqual([clean.state, clean.totals.rate, clean.totals.occurrences], ["ready", 0, 0]);
  // A kind a later version writes is left out, not a failure.
  assert.equal(page([finding({ kind: "something_new" })]).totals.occurrences, 0);
});

test("links: a group narrows the table and lets go on a second pick; an occurrence opens its call in Traces", () => {
  const model = page([
    finding({ turnId: "turn-a", eventId: "event-a" }),
    finding({
      kind: "value_not_allowed",
      requestedToolId: null,
      toolId: "update_task",
      worked: false,
    }),
  ]);
  const links = hallucinationsLinks(model);
  assert.deepEqual(
    links.groups.map((group) => [group.label, group.href, group.active]),
    [
      ["Tool hallucinations", "/project/p1/health/hallucinations?group=tool", false],
      ["Input hallucinations", "/project/p1/health/hallucinations?group=input", false],
      ["Completion hallucinations", "/project/p1/health/hallucinations?group=completion", false],
    ],
  );
  assert.deepEqual(
    links.listed.map((group) => group.group),
    ["tool", "input"],
    "a group with nothing is not listed",
  );
  const example = links.groups[0]!.kinds[0]!.examples.find((entry) => entry.turnId === "turn-a")!;
  assert.equal(example.traceHref, "/project/p1/traces/turns/turn-a?focus=event-a#event-event-a");

  const narrowed = hallucinationsLinks(
    page(
      [
        finding(),
        finding({ kind: "value_not_allowed", requestedToolId: null, toolId: "update_task" }),
      ],
      { group: "input" },
    ),
  );
  assert.deepEqual(
    narrowed.listed.map((group) => group.group),
    ["input"],
  );
  assert.equal(
    narrowed.groups[1]!.href,
    "/project/p1/health/hallucinations",
    "the active group lets go",
  );
  assert.equal(
    narrowed.groups[1]!.share,
    0.5,
    "a picked group keeps its share of every occurrence",
  );
  assert.equal(
    hallucinationsHref("p1", { days: 7, group: "tool", open: "tool_rerouted" }),
    "/project/p1/health/hallucinations?days=7&group=tool&open=tool_rerouted",
  );
});

test("a picked kind narrows the table to it, inside its group", () => {
  const findings = [
    finding(),
    finding({ kind: "tool_action_changed" }),
    finding({ kind: "value_not_allowed", requestedToolId: null, toolId: "update_task" }),
  ];
  const open = hallucinationsLinks(page(findings, { group: "tool" }));
  const rerouted = open.groups[0]!.kinds.find((kind) => kind.kind === "tool_rerouted")!;
  assert.equal(rerouted.href, "/project/p1/health/hallucinations?kind=tool_rerouted");
  assert.equal(rerouted.active, false);

  const narrowed = hallucinationsLinks(page(findings, { kind: "tool_rerouted" }));
  assert.equal(narrowed.activeGroup, "tool", "a kind names its group");
  assert.equal(narrowed.activeKind, "tool_rerouted");
  assert.deepEqual(
    narrowed.listed.map((group) => [group.group, group.kinds.map((kind) => kind.kind)]),
    [["tool", ["tool_rerouted"]]],
  );
  assert.equal(
    narrowed.groups[0]!.kinds.length,
    2,
    "the group still shows every kind to pick from",
  );
  const picked = narrowed.groups[0]!.kinds.find((kind) => kind.active)!;
  assert.equal(
    picked.href,
    "/project/p1/health/hallucinations?group=tool",
    "the active kind widens back to its group",
  );
  assert.equal(
    narrowed.groups[0]!.href,
    "/project/p1/health/hallucinations?group=tool",
    "with a kind picked, the group widens instead of letting go",
  );
  assert.equal(narrowed.groups[0]!.staysPicked, true);
  assert.equal(
    hallucinationsLinks(page(findings, { kind: "nope" })).activeKind,
    null,
    "an unknown kind is no filter",
  );
});

test("a turn's markers say what the trace shows, from stored values alone", () => {
  const markers = turnMarkers("p1", [
    {
      stepOrdinal: 2,
      kind: "tool_action_changed",
      toolId: "create_document",
      requestedToolId: "get_document",
      repeats: 2,
      worked: false,
    },
    {
      stepOrdinal: 4,
      kind: "unknown_reference",
      toolId: "update_task",
      requestedToolId: null,
      repeats: 1,
      worked: false,
    },
    {
      stepOrdinal: 5,
      kind: "not_a_kind",
      toolId: "x",
      requestedToolId: null,
      repeats: 1,
      worked: false,
    },
  ]);
  assert.deepEqual(
    markers.map((marker) => [marker.stepOrdinal, marker.label, marker.detail, marker.href]),
    [
      [
        2,
        "Rerouted to a different action",
        "Asked for get_document, which is not a tool. create_document ran instead and failed. 2 tries in a row.",
        "/project/p1/health/hallucinations?open=tool_action_changed",
      ],
      [
        4,
        "Referred to something that doesn't exist",
        "update_task was given a record that does not exist.",
        "/project/p1/health/hallucinations?open=unknown_reference",
      ],
    ],
  );
});

test("a group whose rules had nothing to read is not checked, with the reason; one with findings always was", () => {
  // A model reading people's messages alone does not check completion: the claim is in the reply.
  const coverage = { requestedToolIds: false, errorText: false, replies: false, modelReads: true };
  const model = buildHallucinationsPage(
    {
      projectId: "p1",
      windowDays: 30,
      findings: [],
      turns: 100,
      lastReadAt: new Date("2026-09-02T00:00:00Z"),
      capped: false,
      coverage,
    },
    parseHallucinationsQuery({}),
  );
  assert.deepEqual(
    model.groups.map((group) => [group.group, group.unchecked === null]),
    [
      ["tool", false],
      ["input", false],
      ["completion", false],
    ],
  );
  assert.equal(uncheckedReason("completion", { ...coverage, replies: true }), null);
  assert.match(uncheckedReason("input", coverage)!, /no text/);
  const found = buildHallucinationsPage(
    {
      projectId: "p1",
      windowDays: 30,
      findings: [finding()],
      turns: 100,
      lastReadAt: new Date("2026-09-02T00:00:00Z"),
      capped: false,
      coverage,
    },
    parseHallucinationsQuery({}),
  );
  assert.equal(found.groups.find((group) => group.group === "tool")!.unchecked, null);
});

test("the kind a model reads is not checked where no model reads the project's replies", () => {
  const input = (modelReads: boolean, findings: PageFinding[] = []) =>
    buildHallucinationsPage(
      {
        projectId: "p1",
        windowDays: 30,
        findings,
        turns: 100,
        lastReadAt: new Date("2026-09-02T00:00:00Z"),
        capped: false,
        coverage: { requestedToolIds: true, errorText: true, replies: true, modelReads },
      },
      parseHallucinationsQuery({}),
    );
  const off = input(false);
  assert.deepEqual(
    off.uncheckedKinds.map((entry) => entry.kind),
    ["done_but_person_says_not"],
  );
  assert.match(off.uncheckedKinds[0]!.reason, /no model reads/i);
  // The rest of the completion group was checked: the reply is read by rules.
  assert.equal(off.groups.find((group) => group.group === "completion")!.unchecked, null);
  assert.deepEqual(input(true).uncheckedKinds, []);
  // A kind with findings was checked, whatever the coverage reads.
  assert.deepEqual(
    input(false, [finding({ kind: "done_but_person_says_not" })]).uncheckedKinds,
    [],
  );
});
