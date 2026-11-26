// First: lets node load the components' stylesheet imports, and gives the router contexts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { FocusedHealthView } from "@/components/console/health/focused/FocusedHealthView";
import type { SummaryViewProps } from "@/components/console/health/v2/SummaryView";
import { noApiKeyCta } from "@/lib/console/api-key-cta";
import type { PillarReading } from "@/lib/readings/trace-signals/health-pillars";
import {
  HEALTH_SCORE_VERSION,
  healthScoreView,
  scoredIssues,
} from "@/lib/readings/trace-signals/health-score";
import { type HealthPageModel, windowOptionsForPlan } from "@/lib/readings/trace-signals/view";
import type { Fix } from "@/lib/views/fixes/types";
import { MOCK_HEALTH_MODEL, MOCK_NO_TELEMETRY } from "@/lib/views/health/mock-fixture";
import { pendingHealthModel } from "@/lib/views/health/page-model";
import { render, visibleText } from "@/lib/views/tasks/test-support";
import { findDsViolations } from "../../../../../eslint-rules/ds-tokens.mjs";

/** Agent health with `focusedConsole`: the score and its four categories, in every state. */

const PROJECT = "6b64f504-f84f-447a-afe4-fb84054735fb";
const PILLARS: PillarReading[] = [
  { pillar: "ended", good: 0.91, n: 400 },
  { pillar: "calls", good: 0.98, n: 400 },
];
const ISSUES = scoredIssues(
  MOCK_HEALTH_MODEL.signals.map((signal) => ({
    id: signal.id,
    kind: signal.kind,
    severity: signal.severity,
    totalTurns: signal.evidence.totalTurns,
  })),
);
const SCORE = healthScoreView(
  ISSUES,
  MOCK_HEALTH_MODEL.turns,
  [
    { version: HEALTH_SCORE_VERSION, value: 40 },
    { version: HEALTH_SCORE_VERSION, value: 38 },
  ],
  PILLARS,
);
const MODEL: HealthPageModel = { ...MOCK_HEALTH_MODEL, score: SCORE, evidenceTurnsPerSignal: 6 };
const COMBINE = {
  id: "craft:fx-2",
  aliases: ["issue:sig-chain-find-assign"],
  title: "Combine find_task and assign_task",
  status: "open",
  kind: "combine",
  source: "craft",
  subject: { tools: [], tasks: [], topics: [] },
} as unknown as Fix;
const REMOVED = [
  "Raise it next",
  "First try",
  "Turn shapes",
  "Self-corrections",
  "Tasks that need a look",
  "Call order",
  "Open issues",
];

type Props = Omit<SummaryViewProps, "corrections">;

function page(over: Partial<Props> = {}, search = ""): string {
  const props: Props = {
    projectId: PROJECT,
    projectName: "Site Copilot",
    model: MODEL,
    state: { kind: "ready" },
    windowOptions: windowOptionsForPlan(30),
    billingHref: null,
    tasks: null,
    fixes: { open: [COMBINE], applied: [] },
    reportHref: `/report/health/${PROJECT}?days=7&print=1`,
    imports: null,
    // The page leaves it out and `HealthStateV2` reads it; a test passes it.
    apiKey: noApiKeyCta(PROJECT),
    ...over,
  };
  return render(createElement(FocusedHealthView, props), {
    pathname: `/project/${PROJECT}/health`,
    search,
  });
}

/** Each category's section, in page order. */
function categories(html: string) {
  return html
    .split("<section ")
    .filter((part) => part.includes("data-health-category="))
    .map((part) => ({
      level: part.match(/data-health-category="(\w+)"/)?.[1],
      lost: Number(part.match(/data-health-category-lost="(\d+)"/)?.[1] ?? Number.NaN),
      expanded: part.match(/aria-expanded="(\w+)"/)?.[1] === "true",
      kinds: [...part.matchAll(/data-issue-kind="(\w+)"/g)].map((match) => match[1]),
      rates: [...part.matchAll(/data-health-rate="(\w+)"/g)].map((match) => match[1]),
      text: visibleText(`<section ${part}`),
      html: part,
    }));
}

function assertHouseStyle(html: string) {
  const text = visibleText(html);
  assert.doesNotMatch(text, /—/, "no em dash");
  for (const removed of REMOVED) assert.ok(!text.includes(removed), `no "${removed}"`);
  const violations = [...html.matchAll(/class="([^"]*)"/g)].flatMap((match) =>
    findDsViolations(match[1] ?? ""),
  );
  assert.deepEqual([...new Set(violations)], [], "semantic tokens only");
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1, "one h1");
}

test("the score, its change and trend, then the four categories that add up to what is missing", () => {
  const html = page();
  assertHouseStyle(html);
  const text = visibleText(html);
  assert.match(html, /data-health-score-ring=""/);
  assert.match(text, new RegExp(`${SCORE.value}\\s*of 100`));
  assert.match(text, /since the last reading/);
  assert.match(html, /Health score over the last 3 readings/);
  assert.doesNotMatch(
    html,
    /data-health-score-lost|data-health-score-parts|data-ring-cell="target"/,
  );

  const shown = categories(html);
  assert.deepEqual(
    shown.map(({ level }) => level),
    ["breaks", "misleads", "wastes", "tidies"],
  );
  assert.equal(
    shown.reduce((sum, { lost }) => sum + lost, 0),
    100 - SCORE.value,
  );
  for (const category of shown) {
    assert.equal(
      category.expanded,
      category.lost > 0,
      `${category.level} opens when it loses points`,
    );
  }
  assert.deepEqual(shown.find(({ level }) => level === "breaks")?.rates, ["ended"]);
  assert.match(shown[0]?.text ?? "", /Runs end well\s*91%/);
  assert.deepEqual(shown.find(({ level }) => level === "wastes")?.rates, ["calls"]);
  const kinds = shown.flatMap((category) => category.kinds);
  assert.equal(kinds.length, 14, "every row, in one category");
  assert.match(html, /data-issue-action="fix"[^>]*>Fix</);
  assert.match(html, /data-issue-action="turns"[^>]*>See turns/);
  assert.match(html, /id="signal-sig-no-follow-search-projects"/);
});

test("each category is a labelled expandable section", () => {
  for (const { html } of categories(page())) {
    const label = html.match(/aria-labelledby="([^"]+)"/)?.[1];
    const button = html.match(/<button [^>]*>/)?.[0] ?? "";
    const body = button.match(/aria-controls="([^"]+)"/)?.[1];
    assert.ok(label && button.includes(`id="${label}"`), "the section is named by its button");
    assert.ok(body && html.includes(`id="${body}"`), "the button controls its body");
    assert.match(button, /aria-expanded="(true|false)"/);
  }
});

test("a healthy category is one quiet row with a check", () => {
  const score = healthScoreView([], 100);
  const html = page({ model: { ...MODEL, signals: [], tooEarly: [], score } });
  assertHouseStyle(html);
  for (const category of categories(html)) {
    assert.equal(category.expanded, false);
    assert.match(category.text, /Healthy/);
  }
  assert.equal((html.match(/lucide-circle-check/g) ?? []).length, 4);
});

test("a link to an issue opens its category", () => {
  const score = healthScoreView([], 100);
  const closed = page({ model: { ...MODEL, score } });
  assert.ok(categories(closed).every(({ expanded }) => !expanded));
  const opened = page({ model: { ...MODEL, score } }, "peek=issue:sig-magnet-create-task");
  assert.deepEqual(
    categories(opened).map(({ expanded }) => expanded),
    [false, false, true, false],
  );
});

test("an early reading: the ring beats, nothing claims a change, and more may come", () => {
  const html = page({
    model: {
      ...MODEL,
      earlyReading: true,
      earlyProgress: { read: 1_055, total: 5_315, percent: 19 },
    },
  });
  assertHouseStyle(html);
  assert.match(html, /data-calculating=""/);
  assert.match(html, /data-health-still-reading=""/);
  assert.doesNotMatch(visibleText(html), /since the last reading|first reading with a score/);
});

test("low confidence and inferred tools are said before the score", () => {
  const html = page({
    model: { ...MODEL, lowConfidence: { turns: 12 } } as HealthPageModel,
    inferredTools: true,
  });
  assertHouseStyle(html);
  assert.ok(html.indexOf("data-health-low-confidence") > 0);
  assert.ok(html.indexOf("data-health-low-confidence") < html.indexOf("data-health-score-ring"));
});

test("a plan's locked issues and the dismissed ones keep their lines", () => {
  const html = page({
    model: {
      ...MODEL,
      lockedCount: 3,
      dismissed: [{ id: "d-1", label: "slow_export" }],
    } as unknown as HealthPageModel,
    billingHref: "/org/acme/billing",
    lockedPlan: "Plus",
  });
  assert.match(visibleText(html), /3 more issues on Plus\.\s*See plans/);
  assert.match(visibleText(html), /Hidden as slow by design:\s*slow_export\s*Show again/);
});

test("without a score, what a plan hides is never called healthy", () => {
  const html = page({
    model: { ...MODEL, score: null, signals: [], tooEarly: [], lockedCount: 3 } as HealthPageModel,
  });
  assert.doesNotMatch(html, /data-health-score-ring/);
  for (const category of categories(html)) assert.match(category.text, /Nothing to show/);
});

test("with a score, what a plan hides is never called healthy or counted as none", () => {
  const hidden = (kind: "dead_tool" | "magnet", severity: number, totalTurns: number) =>
    scoredIssues([{ id: `locked-${kind}`, kind, severity, totalTurns }]);
  const locked = (issues: ReturnType<typeof scoredIssues>, pillars: PillarReading[] = []) => {
    const score = healthScoreView(issues, 200, [], pillars);
    const html = page({ model: { ...MODEL, signals: [], tooEarly: [], lockedCount: 1, score } });
    assertHouseStyle(html);
    for (const { text } of categories(html))
      assert.doesNotMatch(text, /Healthy|0 issues|No issues here/);
    assert.doesNotMatch(html, /lucide-circle-check/);
    return categories(html);
  };
  const tidying = locked(hidden("dead_tool", 1, 0)).find(({ level }) => level === "tidies");
  assert.ok(tidying && tidying.lost > 0);
  assert.match(tidying.text, /Issues not shown/);
  assert.match(tidying.text, /Nothing to list here/);
  const rates = locked(hidden("magnet", 0.5, 2), [{ pillar: "ended", good: 0.91, n: 400 }]);
  assert.match(rates.find(({ level }) => level === "wastes")?.text ?? "", /Nothing to show/);
});

test("points that only a measured rate costs say so, not 0 issues", () => {
  const score = healthScoreView([], 100, [], [{ pillar: "ended", good: 0.8, n: 100 }]);
  const html = page({ model: { ...MODEL, signals: [], tooEarly: [], score } });
  assertHouseStyle(html);
  const breaks = categories(html)[0];
  assert.equal(breaks?.lost, 12);
  assert.match(breaks?.text ?? "", /Measured rates/);
  assert.match(breaks?.text ?? "", /The points come from the rates above\./);
  assert.doesNotMatch(breaks?.text ?? "", /0 issues|No issues here in/);
});

test("a gap in the data: no score, the issues that stand, and how to close it", () => {
  const html = page({
    model: {
      ...MODEL,
      workflows: { items: [], chainOwners: {}, unserved: [], blocked: "mixed_runs" },
      setup: {
        version: 1,
        lanes: { sdk: true, otel: false },
        facts: [{ key: "sdk_turn_ids", status: "off", share: 0 }],
        warnings: ["mixed_runs"],
      },
    } as unknown as HealthPageModel,
  });
  assertHouseStyle(html);
  assert.doesNotMatch(html, /data-health-score-ring/);
  assert.equal(categories(html).length, 4);
  assert.match(html, /data-health-gap="mixed_runs"[^]*How to send turn ids/);
});

test("before a reading: today's states, and no section the page no longer has", () => {
  for (const [model, state] of [
    [MOCK_NO_TELEMETRY, null],
    [pendingHealthModel(7), null],
  ] as const) {
    const html = page({ model, state });
    assertHouseStyle(html);
    assert.match(html, /data-health-page-state="(?!ready)/);
    assert.equal(categories(html).length, 0);
  }
});

const StubShareDialog = () => createElement("div", { "data-share-dialog": "" });

test("shared: the edition's dialog stays in the header", () => {
  const html = page({
    share: {
      link: null,
      canManage: true,
      Dialog: StubShareDialog,
    },
  });
  assert.match(html, /data-share-dialog/);
});
