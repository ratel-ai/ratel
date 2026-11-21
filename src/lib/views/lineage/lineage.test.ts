import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fix } from "@/lib/views/fixes/types";
import { lineageShowsTraces } from "./plan";
import {
  appliedRewriteShipmentId,
  experimentRef,
  fixRef,
  fixSourceRef,
  hrefFor,
  insightRef,
  metricRef,
  refPhrase,
  shipmentRef,
  shipmentSourceRef,
  shortId,
  traceRef,
} from "./refs";
import { STAGE_ROUTES, stageOfPath } from "./stages";
import { LINEAGE_STAGES, type LineageRef, nextStage, previousStage, stageOfKind } from "./types";

const P = "p1";

test("LineageRef is the shared contract's shape, and the spine runs Monitor to Ship", () => {
  const ref: LineageRef = {
    stage: "insights",
    kind: "insight",
    id: "s1",
    label: "Wrong tool",
    href: "/x",
  };
  assert.deepEqual(Object.keys(ref).sort(), ["href", "id", "kind", "label", "stage"]);
  assert.deepEqual(LINEAGE_STAGES, ["monitor", "insights", "improve", "ship"]);
  assert.equal(previousStage("monitor"), null);
  assert.equal(previousStage("ship"), "improve");
  assert.equal(nextStage("improve"), "ship");
  assert.equal(nextStage("ship"), null);
  assert.equal(stageOfKind("trace"), "monitor");
  assert.equal(stageOfKind("insight"), "insights");
  assert.equal(stageOfKind("eval"), "improve");
  assert.equal(stageOfKind("shipment"), "ship");
  assert.equal(stageOfKind("release"), null, "a kind the spine does not know yet has no stage");
});

test("every kind opens on its page; a ref's own href wins", () => {
  assert.equal(hrefFor(traceRef("abc 1"), P), "/project/p1/traces/abc%201");
  assert.equal(hrefFor(metricRef("first_try"), P), "/project/p1");
  assert.equal(hrefFor(insightRef("s1"), P), "/project/p1/health#signal-s1");
  assert.equal(
    hrefFor({ stage: "insights", kind: "intent", id: "t1" }, P),
    "/project/p1/intents?peek=t1",
  );
  assert.equal(
    hrefFor({ stage: "insights", kind: "task", id: "wf_1" }, P),
    "/project/p1/health/tasks/wf_1",
  );
  assert.equal(hrefFor(fixRef("issue:s1"), P), "/project/p1/improvement/fixes?peek=issue%3As1");
  assert.equal(
    hrefFor(experimentRef("retrieval v2/beta"), P),
    "/project/p1/calibration/~retrieval%20v2%2Fbeta",
  );
  assert.equal(hrefFor(shipmentRef("rewrite:r1"), P), "/project/p1/ship?peek=rewrite%3Ar1");
  assert.equal(
    hrefFor({ stage: "improve", kind: "eval", id: "e1", href: "/project/p1/evals/e1" }, P),
    "/project/p1/evals/e1",
  );
  assert.equal(hrefFor({ stage: "ship", kind: "release", id: "r1" }, P), null, "no page, no link");
});

function fix(
  over: Partial<Pick<Fix, "issues" | "intent" | "subject">>,
): Pick<Fix, "issues" | "intent" | "subject"> {
  return { issues: [], subject: { tools: [], tasks: [], topics: [] }, ...over };
}

test("a fix comes from the worst issue it resolves, else its intent, else its busiest task", () => {
  const issue = {
    id: "s1",
    kind: "wrong_tool",
    title: "Wrong tool keeps showing up",
    claim: "",
    cost: "",
    figure: null,
    href: "/project/p1/health#signal-s1",
  };
  assert.deepEqual(fixSourceRef(P, fix({ issues: [issue, { ...issue, id: "s2" }] })), {
    stage: "insights",
    kind: "insight",
    id: "s1",
    label: "Wrong tool keeps showing up",
    href: "/project/p1/health#signal-s1",
  });
  assert.equal(
    fixSourceRef(P, fix({ intent: { id: "t1", label: "Book a flight", href: "/i" } }))?.kind,
    "intent",
  );
  const task = { id: "wf_1", label: "Refund an order", color: null, href: "/t" };
  assert.deepEqual(fixSourceRef(P, fix({ subject: { tools: [], tasks: [task], topics: [] } })), {
    stage: "insights",
    kind: "task",
    id: "wf_1",
    label: "Refund an order",
    href: "/t",
  });
  assert.equal(
    fixSourceRef(P, fix({})),
    null,
    "a rewrite drafted from missed searches alone names no insight",
  );
});

test("an applied rewrite ships as itself and comes from its fix", () => {
  const id = appliedRewriteShipmentId("r1");
  assert.equal(id, "rewrite:r1");
  assert.deepEqual(shipmentSourceRef(id, "Rewrite lookup"), {
    stage: "improve",
    kind: "fix",
    id: "rewrite:r1",
    label: "Rewrite lookup",
  });
  assert.equal(shipmentSourceRef("release-7"), null);
});

test("ids are cut in the middle and labels read whole", () => {
  assert.equal(shortId("abc"), "abc");
  assert.equal(shortId("4f2a91d0c3b2e1f0a9c07e"), "4f2a91d…a9c07e");
  assert.equal(refPhrase(traceRef("4f2a91d0c3b2e1f0a9c07e")), "trace 4f2a91d…a9c07e");
  assert.equal(
    refPhrase(insightRef("s1", "Wrong tool keeps showing up")),
    "insight Wrong tool keeps showing up",
  );
});

test("every project page has one stage, or none when it is setup", () => {
  const cases: [string, ReturnType<typeof stageOfPath>][] = [
    ["/project/p1", "monitor"],
    ["/project/p1/", "monitor"],
    ["/project/p1/dashboards", "monitor"],
    ["/project/p1/traces", "monitor"],
    ["/project/p1/traces/abc", "monitor"],
    ["/project/p1/traces/spans", "monitor"],
    ["/project/p1/runtime-events", "monitor"],
    ["/project/p1/health", "insights"],
    ["/project/p1/insights", "insights"],
    ["/project/p1/health/tasks/wf_1", "insights"],
    ["/project/p1/health/self-corrections", "insights"],
    ["/project/p1/intents/flows", "insights"],
    ["/project/p1/improvement/tool-explorer", "insights"],
    ["/project/p1/improvement", "improve"],
    ["/project/p1/improvement/fixes", "improve"],
    ["/project/p1/improvement/tool-explorer/suggestions", "improve"],
    ["/project/p1/quality/experiments", "improve"],
    ["/project/p1/calibration/~shadow", "improve"],
    ["/project/p1/improvement/match-quality", "improve"],
    ["/project/p1/improvement/adaptive-ranking/cloud", "improve"],
    ["/project/p1/ship", "ship"],
    ["/project/p1/catalogs/tools", null],
    ["/project/p1/playground", null],
    ["/project/p1/models/embeddings", null],
    ["/project/p1/settings/api-keys", null],
    ["/org/acme", null],
    ["/project/p1/traces?range=7d", "monitor"],
  ];
  for (const [path, stage] of cases) assert.equal(stageOfPath(path), stage, path);
  for (const stage of LINEAGE_STAGES)
    assert.ok(STAGE_ROUTES[stage].length > 0, `${stage} has pages`);
});

// Owned (ADR-0030): this edition has one plan, with example turns; only an override closes runs.
test("lineageShowsTraces: an insight names its run unless the organization has no example turns", () => {
  const org = (over: Partial<Parameters<typeof lineageShowsTraces>[0]> = {}) => ({
    id: "org-1",
    limitOverrides: null,
    ...over,
  });
  // The Ship breadcrumb and the lineage API both read this, so they say the same thing.
  assert.equal(lineageShowsTraces(org()), true);
  assert.equal(
    lineageShowsTraces(org({ limitOverrides: { agentHealthEvidenceTurns: 0 } })),
    false,
    "no example turns: From metric",
  );
  assert.equal(
    lineageShowsTraces(org({ limitOverrides: { agentHealthEvidenceTurns: 3 } })),
    true,
    "a per-org override opens runs",
  );
});
