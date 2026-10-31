import assert from "node:assert/strict";
import { test } from "node:test";
import { renderSiteCopilotOtlp } from "@/lib/console/seed/site-copilot-otlp";
import { planSiteCopilot } from "@/lib/console/seed/site-copilot-plan";
import {
  agreement,
  answerFor,
  answerKeyLabels,
  keywordSearch,
  logsExport,
  planQualitySearches,
  qualityTimeline,
  replayAnalyst,
  type SearchSighting,
  SITE_QUALITY_EXPERIMENT,
  type SiteSearch,
  searchTime,
  sightingRecords,
  withoutEmDashes,
} from "@/lib/console/seed/site-copilot-quality";
import { SITE_QUALITY_CAPTURED } from "@/lib/console/seed/site-copilot-quality-fixture";
import type { AnalystContext } from "@/lib/synthesis/match-quality/context";
import { queryKey } from "@/lib/synthesis/match-quality/labels";

const calls = (...tools: string[]) =>
  tools.map((tool) => ({ tool })) as unknown as Parameters<typeof answerFor>[0]["calls"];

test("each ask's right tool is what it wants, not the lookup the agent ran first", () => {
  assert.equal(
    answerFor({
      kind: "material_delivery",
      topic: "material_delivery",
      calls: calls("list_projects", "get_purchase_order", "track_material_delivery"),
    }),
    "track_material_delivery",
  );
  assert.equal(
    answerFor({
      kind: "spec_question",
      topic: "spec_question",
      calls: calls("get_project_info", "search_spec_book"),
    }),
    "search_spec_book",
  );
  assert.equal(
    answerFor({ kind: "rfis", topic: "rfis", calls: calls("list_rfis", "get_rfi") }),
    "get_rfi",
  );
  assert.equal(answerFor({ kind: "rfis", topic: "rfis", calls: calls("list_rfis") }), "list_rfis");
  assert.equal(
    answerFor({
      kind: "safety_report",
      topic: "safety_report",
      calls: calls("log_safety_incident", "notify_team"),
    }),
    "log_safety_incident",
  );
  assert.equal(
    answerFor({
      kind: "subcontractors",
      topic: "subcontractors",
      calls: calls("list_subcontractors", "get_subcontractor_compliance"),
    }),
    "get_subcontractor_compliance",
  );
  assert.equal(
    answerFor({
      kind: "payment_status",
      topic: "payment_status",
      calls: calls("get_pay_application"),
    }),
    "get_pay_application",
  );
  assert.equal(
    answerFor({ kind: "thanks", topic: null, calls: calls("notify_team") }),
    "notify_team",
  );
  assert.equal(
    answerFor({ kind: "thanks", topic: null, calls: calls() }),
    null,
    "a plain thanks searches for nothing",
  );
  assert.equal(
    answerFor({
      kind: "try_again",
      topic: "material_delivery",
      calls: calls("track_material_delivery"),
    }),
    null,
    "a retry repeats the call without a search",
  );
  assert.equal(
    answerFor({
      kind: "equipment_rental",
      topic: "equipment_rental",
      calls: calls("get_project_info"),
    }),
    "unanswerable",
  );
  assert.equal(
    answerFor({
      kind: "correction",
      topic: "schedule_status",
      calls: calls("get_project_schedule"),
    }),
    "get_project_schedule",
  );
  assert.equal(
    answerFor({
      kind: "correction",
      topic: null,
      calls: calls("get_purchase_order", "track_material_delivery"),
    }),
    "track_material_delivery",
  );
});

test("the searches are planned the same way every time, under the stored traces' own ids", () => {
  const plan = planSiteCopilot({ turns: 40 });
  const searches = planQualitySearches(plan);
  assert.deepEqual(planQualitySearches(planSiteCopilot({ turns: 40 })), searches);
  assert.ok(searches.length > 20);
  const rendered = renderSiteCopilotOtlp(plan, { anchorMs: Date.UTC(2026, 9, 20) });
  const roots = new Map<string, string>();
  for (const body of rendered.batches as {
    resourceSpans: {
      scopeSpans: { spans: { traceId: string; spanId: string; parentSpanId?: string }[] }[];
    }[];
  }[]) {
    for (const span of body.resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans),
    )) {
      if (!span.parentSpanId) roots.set(span.traceId, span.spanId);
    }
  }
  for (const search of searches) {
    assert.equal(
      roots.get(search.traceId),
      search.rootSpanId,
      `${search.key} rides on its turn's trace`,
    );
    assert.match(search.selectionId, /^sel_[0-9a-f]{24}$/);
  }
  assert.ok(searches.every((search) => ["compared", "skipped", "dropped"].includes(search.fate)));
});

test("the customer's search matches words, unweighted, catalog order breaking ties", () => {
  const search = keywordSearch([
    {
      entryId: "list_projects",
      name: "list_projects",
      searchable: "List the company's active construction projects.",
    },
    {
      entryId: "get_project_schedule",
      name: "get_project_schedule",
      searchable: "Read a project's schedule: activities with planned dates.",
    },
    {
      entryId: "track_material_delivery",
      name: "track_material_delivery",
      searchable: "Track a delivery with the supplier's logistics service.",
    },
  ]);
  assert.deepEqual(
    search("Is the deck pour on track or behind?", 3),
    ["track_material_delivery"],
    "a shared word wins, the right tool or not",
  );
  assert.deepEqual(search("project schedule for the activities", 3), [
    "get_project_schedule",
    "list_projects",
  ]);
  assert.deepEqual(search("hello there", 3), []);
  assert.deepEqual(search("project", 1), ["list_projects"]);
});

test("agreement between two lists, as the SDK stamps it", () => {
  assert.deepEqual(agreement(["a", "b"], ["a", "b"], 5), {
    top1: true,
    exactOrder: true,
    overlap: 2,
    jaccard: 1,
  });
  assert.deepEqual(agreement(["a", "b"], ["b", "c"], 5), {
    top1: false,
    exactOrder: false,
    overlap: 1,
    jaccard: 1 / 3,
  });
  assert.deepEqual(agreement([], [], 5), { top1: false, exactOrder: true, overlap: 0, jaccard: 1 });
});

function search(overrides: Partial<SiteSearch> = {}): SiteSearch {
  return {
    key: "c1:t1",
    traceId: "0123456789abcdef0123456789abcdef",
    rootSpanId: "0123456789abcdef",
    selectionId: "sel_000000000000000000000001",
    query: "When does the drywall arrive at Harbor Point?",
    answer: "track_material_delivery",
    called: ["get_purchase_order", "track_material_delivery"],
    fate: "compared",
    ...overrides,
  };
}

const attrs = (record: { attributes: { key: string; value: Record<string, unknown> }[] }) =>
  Object.fromEntries(record.attributes.map(({ key, value }) => [key, Object.values(value)[0]]));

test("one compared search sends both lists, the comparison, and the agent's call by its rank only", () => {
  const sighting: SearchSighting = {
    search: search(),
    at: new Date("2026-10-20T15:00:00.000Z"),
    ours: ["get_purchase_order", "track_material_delivery"],
    theirs: ["get_daily_log"],
  };
  const records = sightingRecords(sighting);
  assert.deepEqual(
    records.map((record) => record.eventName),
    [
      "ratel.experiment.results",
      "ratel.experiment.results",
      "ratel.experiment.comparison",
      "ratel.experiment.invocation",
    ],
  );
  const comparison = attrs(records[2]!);
  assert.equal(comparison["ratel.experiment.id"], SITE_QUALITY_EXPERIMENT);
  assert.equal(comparison["ratel.experiment.served.arm"], "legacy");
  assert.equal(comparison["ratel.experiment.shadow.arm"], "ratel");
  assert.equal(comparison["ratel.experiment.role"], "shadow");
  assert.equal(comparison["ratel.experiment.agreement.top1"], false);
  assert.equal(
    comparison["ratel.experiment.query"],
    "When does the drywall arrive at Harbor Point?",
  );
  assert.equal(
    records[2]!.traceId,
    sighting.search.traceId,
    "the comparison links to the turn's trace",
  );
  const invocation = attrs(records[3]!);
  assert.equal(invocation["ratel.experiment.invocation.rank"], "-1", "not in the served list");
  assert.equal(
    invocation["ratel.experiment.invocation.tool_id"],
    undefined,
    "the SDK records where, not which",
  );
  assert.ok(
    records.every((record) =>
      attrs(record)["ratel.event.id"]?.toString().startsWith("site-copilot-quality:c1:t1:"),
    ),
    "stable ids make a rerun store nothing new",
  );
  const skipped = sightingRecords({ ...sighting, search: search({ fate: "skipped" }) });
  assert.deepEqual(
    skipped.map((record) => record.eventName),
    ["ratel.experiment.skip"],
  );
  const unanswerable = sightingRecords({ ...sighting, search: search({ answer: "unanswerable" }) });
  assert.equal(
    unanswerable.some((record) => record.eventName === "ratel.experiment.invocation"),
    false,
  );
  const body = logsExport(records) as {
    resourceLogs: { scopeLogs: { logRecords: unknown[] }[] }[];
  };
  assert.equal(body.resourceLogs[0]!.scopeLogs[0]!.logRecords.length, 4);
});

test("the answer key: one row per ask, unanswerable asks left unclear, a share not read yet", () => {
  const at = new Date("2026-10-20T15:00:00.000Z");
  const sightings: SearchSighting[] = Array.from({ length: 60 }, (_, index) => ({
    search: search({
      key: `c${index}:t1`,
      query: `Where is the order ${index % 30}?`,
      answer: index % 30 === 0 ? "unanswerable" : "track_material_delivery",
    }),
    at: new Date(at.getTime() + index * 1000),
    ours: ["get_purchase_order"],
    theirs: [],
  }));
  const labels = answerKeyLabels(sightings, { judgedAt: at, fingerprint: "fp" });
  assert.ok(labels.length <= 30);
  const unclear = labels.find((label) => label.queryKey === queryKey("Where is the order 0?"));
  assert.deepEqual(
    { source: unclear?.source, entryId: unclear?.entryId },
    { source: "unclear", entryId: "" },
  );
  const judged = labels.filter((label) => label.source === "judge");
  assert.ok(judged.length > 20 && judged.length < 30, "most asks are judged, some wait");
  for (const label of judged) {
    assert.equal(label.entryId, "track_material_delivery");
    assert.equal(label.occurrences, 2);
    assert.equal(label.runnerUp, "get_purchase_order");
    assert.ok(label.confidence! >= 0.62 && label.confidence! <= 0.98);
    assert.equal(label.catalogFingerprint, "fp");
  }
  assert.deepEqual(
    answerKeyLabels(sightings, { judgedAt: at, fingerprint: "fp" }),
    labels,
    "deterministic",
  );
});

test("two weekly runs two weeks apart, the operator a day after the first", () => {
  const timeline = qualityTimeline(new Date("2026-10-21T00:48:19.289Z"));
  assert.equal(timeline.latest.createdAt.toISOString(), "2026-10-21T01:09:00.000Z");
  assert.equal(timeline.latest.windowStart.toISOString(), "2026-10-07T01:09:00.000Z");
  assert.equal(timeline.earlier.createdAt.toISOString(), "2026-10-07T01:09:00.000Z");
  assert.equal(timeline.actedAt.toISOString(), "2026-10-08T03:09:00.000Z");
  assert.equal(timeline.latest.windowDays, 14);
  assert.equal(
    searchTime(new Date("2026-10-20T15:00:00.000Z")).toISOString(),
    "2026-10-20T15:00:00.250Z",
  );
});

test("a seeded run replays the captured analysis, for tools the catalog has", async () => {
  const context = {
    corpus: [{ entryId: "get_project_schedule" }, { entryId: "notify_team" }],
    candidates: [],
  } as unknown as AnalystContext;
  const analyst = replayAnalyst(context, {
    diagnosis: "Read.",
    points: [],
    rewrites: {
      get_project_schedule: {
        searchableDescription: "S",
        rationale: "R",
        details: "D",
        expectedEffect: "E",
      },
      not_in_catalog: {
        searchableDescription: "S",
        rationale: "R",
        details: "D",
        expectedEffect: "E",
      },
    },
  });
  const answer = JSON.parse(await analyst.complete("", "")) as {
    proposals: { entryId: string }[];
    diagnosis: { headline: string };
  };
  assert.deepEqual(
    answer.proposals.map((proposal) => proposal.entryId),
    ["get_project_schedule"],
  );
  assert.equal(answer.diagnosis.headline, "Read.");
});

test("the console's punctuation: no em dash in the captured answers, or in a new capture", () => {
  assert.equal(
    withoutEmDashes("a work activity \u2014 a deck pour, a slab \u2014 is on track"),
    "a work activity (a deck pour, a slab) is on track",
  );
  assert.equal(
    withoutEmDashes("it reads one document \u2014 not the bundle."),
    "it reads one document: not the bundle.",
  );
  assert.doesNotMatch(JSON.stringify(SITE_QUALITY_CAPTURED), /\u2014/);
  assert.ok(Object.keys(SITE_QUALITY_CAPTURED.latest.rewrites).length >= 4);
});
