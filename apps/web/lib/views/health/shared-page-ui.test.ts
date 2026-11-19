import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ShareLayout from "@/app/share/(view)/layout";
import { HealthPageView } from "@/components/console/health/HealthPageView";
import { SharedPageActions } from "@/components/console/health/share/SharedPageActions";
import { healthScoreView, scoredIssues } from "@/lib/readings/trace-signals/health-score";
import type { HealthPageModel, WorkflowsView } from "@/lib/readings/trace-signals/view";
import { MOCK_COLLECTING, MOCK_HEALTH_MODEL } from "@/lib/views/health/mock-fixture";
import { publicHealthModel } from "@/lib/views/health/public-model";
import { healthReportHref, sharePath, shareReportPath } from "@/lib/views/health/share-paths";

/**
 * The interactive page behind an Agent health share link, under upstream's share layout. The
 * render cases are upstream's (`lib/trace-signals/share/share.test.ts`); the layout and actions
 * cases pin the share bar upstream shows around the page.
 */

const WORKFLOWS: WorkflowsView = {
  items: [
    {
      id: "wf-1",
      name: "Close out a release",
      description: null,
      icon: "rocket",
      steps: [
        { id: "find_pr", label: "find_pr" },
        { id: "notify", label: "notify" },
      ],
      focusTools: ["find_pr", "notify"],
      runs: 45,
      share: 0.2,
      completion: 0.67,
      medianMs: 7_200,
      problem: null,
      build: null,
      failingStep: null,
      slowestStep: null,
      examples: [{ turnId: "turn-secret-1", focusEventId: "event-secret-1", why: "failed" }],
      stoppedShort: null,
    },
  ],
  multiToolTurns: 100,
  assignedTurns: 45,
  minTools: 2,
  minRuns: 5,
  chainOwners: {},
  unserved: [],
  blocked: null,
  readingSince: null,
  excludedRuns: 0,
  asksFrom: "user",
};

const FULL: HealthPageModel = { ...MOCK_HEALTH_MODEL, workflows: WORKFLOWS };

function renderShared(model: HealthPageModel): string {
  return renderToStaticMarkup(
    createElement(HealthPageView, {
      projectId: "shared",
      projectName: "Support agent",
      model: publicHealthModel(model),
      windowOptions: [],
      shared: { organizationName: "Acme" },
    }),
  );
}

function scored(model: HealthPageModel): HealthPageModel {
  const issues = scoredIssues(
    model.signals.map((s) => ({
      id: s.id,
      kind: s.kind,
      severity: s.severity,
      totalTurns: s.evidence.totalTurns,
    })),
  );
  const pillars = [
    { pillar: "ended" as const, good: 0.97, n: 500 },
    { pillar: "top_5" as const, good: 0.84, n: 500 },
  ];
  return { ...model, score: healthScoreView(issues, model.turns, [], pillars) };
}

const projectLinks = (html: string) =>
  [...html.matchAll(/href="([^"]+)"/g)]
    .map((m) => m[1] ?? "")
    .filter((href) => !href.startsWith("#"));

test("the shared page links nowhere inside the project and carries no setup or upsell", () => {
  const html = renderShared(FULL);
  assert.deepEqual(projectLinks(html), []);
  assert.match(html, /Shared by Acme/);
  assert.match(html, /data-health-window-fixed="7"/);
  assert.doesNotMatch(html, /aria-label="Window"/);
  assert.doesNotMatch(html, /on Plus|See plans/);
  assert.doesNotMatch(html, /data-setup-card|data-capture-nudge/);
  assert.match(html, /data-signal-list="true"/);

  const collecting = renderShared(MOCK_COLLECTING);
  assert.match(collecting, /data-health-state="shared_not_ready"/);
  assert.doesNotMatch(collecting, /settings\/api-keys/);
});

test("a slow tool can be hidden as slow by design on the team's page, never on the shared one", () => {
  const slow = MOCK_HEALTH_MODEL.signals.find((signal) => signal.kind === "latency_outlier");
  assert.ok(slow, "the fixture has a slow tool");
  const dismissed = [
    {
      id: "sig-hidden",
      kind: "wait_heavy" as const,
      toolId: "render_video",
      label: "Render video",
    },
  ];
  const team = renderToStaticMarkup(
    createElement(HealthPageView, {
      projectId: "p1",
      projectName: "Support agent",
      model: { ...FULL, dismissed },
      windowOptions: [],
    }),
  );
  assert.match(team, new RegExp(`data-slow-by-design="${slow.id}"`));
  const shared = renderShared({ ...FULL, dismissed });
  assert.doesNotMatch(shared, /data-slow-by-design|Hidden as slow by design|Show again/);
});

test("the shared page leads its reading with the score, with no way into the project", () => {
  const model = scored(FULL);
  const score = model.score;
  assert.ok(score);
  const html = renderShared(model);
  assert.match(html, new RegExp(`data-health-score="${score.value}"`));
  assert.doesNotMatch(html, /Raise it next/, "no fixes a visitor cannot open");
  assert.deepEqual(projectLinks(html), [], "still links nowhere inside the project");
  assert.doesNotMatch(
    renderShared(FULL),
    /data-health-score=/,
    "no score in the model, none on the page",
  );
});

test("the share layout says it is read-only and where to get it, with no way into the app", () => {
  const html = renderToStaticMarkup(
    createElement(ShareLayout, null, createElement("p", null, "page")),
  );
  assert.match(html, /Read-only view/);
  assert.match(html, /Get this for your agent at ratel\.sh/);
  assert.match(html, /<p>page<\/p>/);
  assert.deepEqual(
    [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]),
    ["https://ratel.sh", "https://ratel.sh"],
  );
});

test("the shared page's actions copy the link and open the printable report", () => {
  const html = renderToStaticMarkup(
    createElement(SharedPageActions, { reportHref: shareReportPath("tok") }),
  );
  assert.match(html, /Copy link/);
  assert.match(html, /Download PDF/);
  assert.match(html, /href="\/share\/health\/tok\/report\?print=1"/);
  assert.match(html, /target="_blank"/);
});

test("share paths: the page, its report, and the member's report", () => {
  assert.equal(sharePath("abc"), "/share/health/abc");
  assert.equal(shareReportPath("abc"), "/share/health/abc/report?print=1");
  assert.equal(shareReportPath("abc", false), "/share/health/abc/report");
  assert.equal(healthReportHref("p 1", 30), "/report/health/p%201?days=30&print=1");
});
