import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextBreakdown } from "@/components/console/home/ContextBreakdown";
import { OverviewView, overviewStats } from "@/components/console/home/OverviewView";
import type { HealthTile } from "@/lib/readings/trace-signals/view";
import type { TraceAggregateSummary, TraceSummary } from "@/lib/synthesis/traces/queries";
import type { Attention, AttentionItem } from "@/lib/views/home/attention";
import type { Glance } from "@/lib/views/home/glance";
import type { OverviewData } from "@/lib/views/home/load";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const ROOT = "/project/p1";

function aggregate(overrides: Partial<TraceAggregateSummary> = {}): TraceAggregateSummary {
  return {
    count: 120,
    errorCount: 6,
    errorRate: 0.05,
    p50DurationMs: 1_800,
    p95DurationMs: 9_000,
    p99DurationMs: 12_000,
    costUsd: 4.2,
    totalTokens: 250_000,
    volume: [],
    ...overrides,
  };
}

function run(overrides: Partial<TraceSummary> = {}): TraceSummary {
  return {
    traceId: "t1",
    rootSpanId: "s1",
    rootName: "invoke_agent support",
    startedAt: new Date("2026-10-15T11:57:00.000Z"),
    endedAt: new Date("2026-10-15T11:57:02.000Z"),
    durationMs: 2_000,
    statusCode: 1,
    serviceName: null,
    spanCount: 4,
    errorCount: 0,
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    costUsd: 0.01,
    experimentName: null,
    experimentArm: null,
    ...overrides,
  };
}

const ISSUE: AttentionItem = {
  key: "issue:a",
  tone: "warning",
  mark: "issue",
  title: "Wrong tool keeps showing up",
  subject: { kind: "tools", tools: [{ name: "create_task", skill: false }], more: 2 },
  figure: { value: "41%", caption: "of lists" },
  target: { kind: "link", href: `${ROOT}/health?peek=issue%3Aa#signal-a` },
};

function glance(overrides: Partial<Glance> = {}): Glance {
  return {
    intents: {
      state: "ready",
      href: `${ROOT}/intents`,
      count: 12,
      top: { id: "t_schedule", name: "Schedule status", href: `${ROOT}/intents?peek=t_schedule` },
      unanswered: [],
    },
    tasks: {
      state: "ready",
      blocked: null,
      href: `${ROOT}/health/tasks`,
      count: 8,
      finishRate: 0.95,
      weakest: {
        id: "wf1",
        name: "Track material delivery",
        slot: "chart-1",
        href: `${ROOT}/health/tasks/wf1`,
        finishRate: 0.876,
      },
      byId: {},
      steps: [],
    },
    selfCorrections: {
      state: "ready",
      href: `${ROOT}/health/self-corrections`,
      windowDays: 7,
      value: "18.4",
      delta: { value: "+1.2", direction: "up", good: false, label: "vs the 7 days before" },
      events: 46,
      topTool: "search_docs",
    },
    fixes: {
      state: "ready",
      href: `${ROOT}/improvement/fixes`,
      open: 6,
      descriptions: 4,
      descriptionsPageHref: `${ROOT}/quality/descriptions`,
    },
    ...overrides,
  };
}

function data(overrides: Partial<OverviewData> = {}): OverviewData {
  const attention: Attention = { items: [ISSUE], moreIssues: 2 };
  return {
    project: { id: "p1", name: "Support bot", slug: "support-bot", isDemo: false },
    root: ROOT,
    window: 7,
    rangeParam: "7d",
    lastEventAt: new Date("2026-10-15T11:59:00.000Z"),
    hasTelemetry: true,
    traces: aggregate(),
    previous: aggregate({ count: 100, errorRate: 0.03, p50DurationMs: 2_000, costUsd: 4 }),
    series: [10, 20, 15, 20, 25, 10, 20],
    daily: {
      failedShare: [0.1, 0, 0.05, null, 0.02, 0, 0.1],
      duration: [1_000, 1_200, 900, null, 2_000, 1_500, 1_800],
      spend: [0.5, 0.6, 0.4, null, 0.9, 0.7, 1.1],
    },
    recentRuns: [run(), run({ traceId: "t2", statusCode: 2, errorCount: 1, rootName: "" })],
    runTasks: {},
    health: null,
    sdk: null,
    attention,
    glance: glance(),
    context: null,
    contextSuggestions: [],
    ...overrides,
  };
}

function render(overview: OverviewData): string {
  return renderToStaticMarkup(
    createElement(OverviewView, {
      data: overview,
      now: NOW,
      setup: createElement("p", { "data-testid": "setup" }, "setup"),
      contextPanel: createElement("aside", { "data-testid": "panel" }),
    }),
  );
}

/** What a reader sees: the markup without its tags. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/** Every attribute value in the markup. */
function attributeValues(html: string): string[] {
  return [...html.matchAll(/\s[\w-]+="([^"]*)"/g)].map((match) => match[1]!);
}

test("renders the project, the window and the four numbers, each with a spark of its days", () => {
  const html = render(data());
  assert.match(html, /<h1[^>]*>.*Support bot/);
  assert.match(html, /data-page="v2"/);
  assert.match(html, /<nav aria-label="Time window"/);
  assert.match(
    html,
    /<a(?=[^>]*aria-current="true")(?=[^>]*href="\/project\/p1")[^>]*>7 days<\/a>/,
  );
  assert.match(html, /<a[^>]*href="\/project\/p1\?range=30d"[^>]*>30 days<\/a>/);
  for (const label of ["Runs", "Failed runs", "Median duration", "Spend"]) {
    assert.match(html, new RegExp(`>${label}</a></dt>`));
  }
  for (const spark of [
    "Runs per day",
    "Failed share of runs per day",
    "Average duration per day",
    "Spend per day",
  ]) {
    assert.match(html, new RegExp(`role="img" aria-label="${spark}, last 7 days"`));
  }
  assert.match(html, /Receiving data/);
  assert.match(html, /data-testid="panel"/);
  assert.doesNotMatch(html, /data-testid="setup"/);
});

test("the one product at a glance: four tiles in the story's order, each opening its page", () => {
  const html = render(data());
  assert.match(html, /<h2[^>]*class="sr-only"[^>]*>At a glance<\/h2>/);
  const order = ["Intents", "Tasks", "Self-corrections", "Fixes"].map((label) =>
    html.indexOf(`${label}<svg`),
  );
  assert.ok(
    order.every((index) => index > 0),
    "every tile is labelled",
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    "intents, tasks, self-corrections, fixes",
  );
  for (const href of [
    "/intents",
    "/health/tasks",
    "/health/self-corrections",
    "/improvement/fixes",
  ]) {
    assert.match(
      html,
      new RegExp(`<a class="[^"]*after:absolute[^"]*" href="/project/p1${href}">`),
    );
  }
});

test("each tile is one number and one line with a pin that opens its own thing", () => {
  const text = visibleText(render(data()));
  assert.match(text, /Intents 12 Top Schedule status Tasks/);
  assert.match(text, /Tasks 95% finish rate Weakest Track material delivery 88%/);
  assert.match(
    text,
    /Self-corrections 18\.4 per 100 turns \+1\.2 vs the 7 days before Most after search_docs/,
  );
  assert.match(text, /Fixes 6 ready 4 description updates/);
  const html = render(data());
  assert.match(
    html,
    /<a class="[^"]*relative z-\[1\][^"]*" href="\/project\/p1\/intents\?peek=t_schedule">/,
  );
  assert.match(
    html,
    /<a class="[^"]*relative z-\[1\][^"]*" href="\/project\/p1\/health\/tasks\/wf1"><span aria-hidden="true" class="[^"]*bg-chart-1/,
  );
  // Description updates are made on Quality › Descriptions; every other fix is on Fixes.
  assert.match(
    html,
    /<a class="[^"]*relative z-\[1\][^"]*" href="\/project\/p1\/quality\/descriptions">4 description updates to apply<\/a>/,
  );
  // The self-correction is a worse figure going up: red, said in words too.
  assert.match(
    html,
    /class="[^"]*text-danger[^"]*" title="vs the 7 days before">.*\+1\.2<span class="sr-only"> vs the 7 days before<\/span>/,
  );
});

test("tiles say why there is no number yet, and a failed read costs only its tile", () => {
  const text = visibleText(
    render(
      data({
        glance: glance({
          intents: { state: "none", href: `${ROOT}/intents`, count: 0, top: null, unanswered: [] },
          tasks: {
            state: "blocked",
            blocked: "mixed_runs",
            href: `${ROOT}/health/tasks`,
            count: 0,
            finishRate: null,
            weakest: null,
            byId: {},
            steps: [],
          },
          selfCorrections: {
            state: "unavailable",
            href: `${ROOT}/health/self-corrections`,
            windowDays: 7,
            value: "0.0",
            delta: undefined,
            events: 0,
            topTool: null,
          },
          fixes: {
            state: "failed",
            href: `${ROOT}/improvement/fixes`,
            open: 0,
            descriptions: 0,
            descriptionsPageHref: "",
          },
        }),
      }),
    ),
  );
  assert.match(text, /Intents – No intents yet/);
  assert.match(text, /Tasks – Runs mix several requests/);
  assert.match(text, /Self-corrections – Couldn't load/);
  assert.match(text, /Fixes – Couldn't load/);
  assert.match(text, /Needs attention/, "the rest of the page still works");
});

test("a tile with nothing weak or nothing to fix says so in a few words", () => {
  const text = visibleText(
    render(
      data({
        glance: glance({
          tasks: { ...glance().tasks, weakest: null },
          selfCorrections: {
            ...glance().selfCorrections,
            topTool: null,
            events: 0,
            delta: undefined,
          },
          fixes: { ...glance().fixes, open: 0, descriptions: 0 },
        }),
      }),
    ),
  );
  assert.match(text, /Tasks 95% finish rate 8 tasks/);
  assert.match(text, /per 100 turns None this week/);
  assert.match(text, /Fixes 0 ready Nothing to change/);
});

test("Needs attention is a row per thing: its mark, a few words, its pins, one number, a chevron", () => {
  const html = render(data());
  const row =
    html.match(
      /<a class="[^"]*" href="\/project\/p1\/health\?peek=issue%3Aa#signal-a">(.*?)<\/a>/,
    )?.[1] ?? "";
  assert.ok(row, "the row links to the issue's panel");
  assert.match(
    row,
    /^<svg[^>]*class="[^"]*lucide-circle-alert[^"]*text-warning/,
    "the issue's noun mark, tinted by tone",
  );
  assert.match(row, /<span class="sr-only">Watch: <\/span>/);
  assert.match(row, />Wrong tool keeps showing up<\/span>/);
  assert.match(row, /lucide-wrench.*>create_task<\/span>/, "the tool as a pin");
  assert.match(row, />\+2<\/span>/);
  assert.match(row, />41%<\/span><span class="[^"]*max-md:sr-only">of lists<\/span>/);
  assert.match(row, /lucide-chevron-right/);
});

test("no Agent health page, no count of more", () => {
  assert.doesNotMatch(render(data({ health: null })), /more in Agent health/);
  assert.match(
    render(data({ health: { href: `${ROOT}/health`, windowDays: 7, firstTry: null } })),
    />2 more in Agent health/,
  );
});

test("rows about a task or an intent carry its pin", () => {
  const html = render(
    data({
      attention: {
        items: [
          {
            ...ISSUE,
            key: "issue:t",
            mark: "task",
            title: "Runs that fail partway",
            subject: { kind: "task", name: "Order materials", slot: "chart-5" },
          },
          {
            key: "intent:t1",
            tone: "warning",
            mark: "intent",
            title: "Mostly unanswered",
            subject: { kind: "intent", name: "Equipment rental" },
            figure: { value: "0%", caption: "answered" },
            target: { kind: "link", href: `${ROOT}/intents?peek=t1` },
          },
        ],
        moreIssues: 0,
      },
    }),
  );
  assert.match(
    html,
    /lucide-list-checks[^>]*text-warning.*Runs that fail partway.*bg-chart-5[^>]*><\/span><span class="min-w-0 truncate">Order materials/,
  );
  assert.match(
    html,
    /href="\/project\/p1\/intents\?peek=t1"><svg[^>]*lucide-message-square-text[^>]*text-warning/,
  );
  assert.match(
    html,
    /lucide-message-square-text shrink-0 text-fg-subtle size-3"[^>]*>(?:(?!<\/svg>).)*<\/svg><span class="min-w-0 truncate">Equipment rental/,
  );
});

test("an empty list says nothing needs you", () => {
  const html = render(data({ attention: { items: [], moreIssues: 0 } }));
  assert.match(html, /Nothing needs you right now/);
});

test("recent runs sit to the side: links to their trace, failures said in words", () => {
  const html = render(data());
  assert.ok(
    html.indexOf("Needs attention") < html.indexOf("Recent runs"),
    "after what needs a look",
  );
  assert.ok(html.indexOf("At a glance") < html.indexOf("Recent runs"));
  assert.match(html, /lg:grid-cols-\[minmax\(0,2fr\)_minmax\(0,1fr\)\]/, "in the narrow column");
  assert.match(html, /<a[^>]*href="\/project\/p1\/traces\/t1"/);
  assert.match(html, /<a[^>]*href="\/project\/p1\/traces\/t2"/);
  assert.match(html, /Unnamed run/);
  assert.equal((html.match(/>Failed</g) ?? []).length, 1);
  assert.match(html, /<time[^>]*dateTime="2026-10-15T11:57:00.000Z"[^>]*>3m ago<\/time>/);
  assert.match(html, /<a[^>]*href="\/project\/p1\/traces\?range=7d"[^>]*>All runs/);
});

test("a run that did a task wears the task's pin instead of its span name", () => {
  const html = render(
    data({
      runTasks: {
        t1: {
          id: "wf1",
          name: "Track material delivery",
          slot: "chart-5",
          href: `${ROOT}/health/tasks/wf1`,
        },
      },
    }),
  );
  const row = html.match(/href="\/project\/p1\/traces\/t1">(.*?)<\/a>/)?.[1] ?? "";
  assert.match(
    row,
    /bg-chart-5[^>]*><\/span><span class="min-w-0 truncate">Track material delivery<\/span>/,
  );
  assert.doesNotMatch(row, /invoke_agent support/);
  assert.doesNotMatch(row, /href=/, "the pin is no link inside the row's link");
  assert.match(html, /Unnamed run/, "a run no task holds keeps its name");
});

test("a quiet window offers the longer one", () => {
  const html = render(data({ recentRuns: [] }));
  assert.match(html, /No runs in the last 7 days/);
  assert.match(html, /<a[^>]*href="\/project\/p1\?range=30d"[^>]*>Last 30 days<\/a>/);
});

test("before the first event the page is the setup guide", () => {
  const html = render(data({ lastEventAt: null, hasTelemetry: false }));
  assert.match(html, /data-testid="setup"/);
  assert.match(html, /No data yet/);
  assert.doesNotMatch(html, />Runs</);
  assert.doesNotMatch(html, /Time window/);
  assert.doesNotMatch(html, /At a glance/);
});

test("the demo project says it is sample data in one line and keeps the tour anchor", () => {
  const html = render(data({ project: { id: "p1", name: "Demo", slug: "demo", isDemo: true } }));
  assert.match(html, /Sample data/);
  assert.match(html, /data-tour="demo-notice"/);
  assert.match(html, /Demo is sample data/);
  assert.match(html, /Every run, cost and fix here is made up\./);
  assert.match(html, /href="\/onboarding"/);
  assert.match(html, /<a[^>]*href="\/project\/p1\/settings\/danger"[^>]*>Delete it<\/a>/);
});

test("stats carry their changes, links and the failed-runs fallback, and no sentences", () => {
  const [runs, failed, duration, spend] = overviewStats(data(), aggregate());
  const versus = "vs the same time 7 days earlier";
  assert.equal(runs.value, "120");
  assert.deepEqual(runs.delta, { value: "+20%", direction: "up", good: null, label: versus });
  assert.equal(runs.href, `${ROOT}/traces?range=7d`);
  assert.equal(failed.label, "Failed runs");
  assert.equal(failed.value, "5%");
  assert.deepEqual(failed.delta, { value: "+2 pts", direction: "up", good: false, label: versus });
  assert.equal(failed.href, `${ROOT}/traces?range=7d&errorOnly=1`);
  assert.equal(duration.value, "1.8s");
  assert.equal(duration.delta?.good, true);
  assert.equal(spend.value, "$4.20");
  assert.equal(spend.href, undefined);
  assert.equal(spend.peek, "context");
  for (const stat of [runs, failed, duration, spend]) {
    assert.equal(stat.hint, undefined, `${stat.label} has no line of text under it`);
    assert.ok(stat.trend, `${stat.label} has a spark`);
  }
});

test("a stat whose days are empty has no spark", () => {
  const [runs, failed, duration, spend] = overviewStats(
    data({
      series: [0, 0, 0, 0, 0, 0, 0],
      daily: { failedShare: [], duration: [null], spend: [0, 0] },
    }),
    aggregate({ count: 0 }),
  );
  for (const stat of [runs, failed, duration, spend])
    assert.equal(stat.trend, undefined, stat.label);
  assert.equal(runs.hint, "None in the last 7 days");
});

const FIRST_TRY = {
  key: "first_try",
  label: "First try",
  value: 0.64,
  unit: "share",
  interval: null,
  sub: "822 of 1,284 turns found the tool first",
  tier: "observed",
  upIsGood: true,
  delta: -0.05,
  series: [
    { day: "2026-10-13", value: 0.6 },
    { day: "2026-10-14", value: null },
    { day: "2026-10-15", value: 0.7 },
  ],
  n: 1284,
} as unknown as HealthTile;

test("first try replaces failed runs once Agent health has a reading, with its days", () => {
  const stats = overviewStats(
    data({
      window: 30,
      rangeParam: "30d",
      health: { href: `${ROOT}/health`, windowDays: 7, firstTry: FIRST_TRY },
    }),
    aggregate(),
  );
  const firstTry = stats[1]!;
  assert.equal(firstTry.label, "First try");
  assert.equal(firstTry.value, "64%");
  assert.deepEqual(firstTry.delta, {
    value: "-5 pts",
    direction: "down",
    good: false,
    label: "vs previous 7 days",
  });
  assert.equal(firstTry.hint, "Last 7 days", "said only when the plan reads another window");
  assert.equal(firstTry.href, `${ROOT}/health`);
  const spark = renderToStaticMarkup(createElement("div", null, firstTry.trend));
  assert.match(spark, /aria-label="First try per day, last 7 days"/);
  assert.match(spark, /data-gap=""/, "a day without turns is a gap");
  assert.equal(stats[3]!.peek, "context");
  const sameWindow = overviewStats(
    data({ health: { href: `${ROOT}/health`, windowDays: 7, firstTry: FIRST_TRY } }),
    aggregate(),
  );
  assert.equal(sameWindow[1]!.hint, undefined);
});

test("no baseline means no change figure", () => {
  const [runs, failed] = overviewStats(
    data({ previous: aggregate({ count: 0, errorRate: 0, costUsd: 0 }) }),
    aggregate(),
  );
  assert.equal(runs.delta, undefined);
  assert.equal(failed.delta, undefined);
  const [unread, , , spend] = overviewStats(data({ previous: null }), aggregate());
  assert.equal(unread.delta, undefined);
  assert.equal(spend.delta, undefined);
});

test("numbers that did not load say so, and the rest of the page stays", () => {
  const html = render(data({ traces: null }));
  assert.match(html, /role="alert"/);
  assert.match(html, /These numbers did not load/);
  assert.doesNotMatch(html, />Runs</);
  assert.match(html, /At a glance/);
  assert.match(html, /Needs attention/);
});

test("recent runs that did not load point to Traces", () => {
  const html = render(data({ recentRuns: null }));
  assert.match(html, /Recent runs did not load/);
  assert.match(html, /<a[^>]*href="\/project\/p1\/traces\?range=7d"[^>]*>Traces<\/a>/);
});

test("the Spend stat and context rows open the panel in place, as real links", () => {
  const html = render(
    data({
      attention: {
        items: [
          {
            key: "context:tools",
            tone: "warning",
            mark: "context",
            title: "Tools never called",
            subject: null,
            figure: { value: "93%", caption: "of tools" },
            target: { kind: "peek", peek: "context" },
          },
        ],
        moreIssues: 0,
      },
    }),
  );
  // Outside the router the path is empty; the query is what matters.
  assert.match(html, /<a[^>]*href="\?peek=context"[^>]*>Spend<\/a>/);
  assert.match(
    html,
    /<a href="\?peek=context" class="[^"]*"><svg[^>]*lucide-layers[^>]*text-warning[^>]*>.*<span class="sr-only">Watch: <\/span>/,
  );
});

test("the context breakdown explains itself without SDK reports", () => {
  const html = renderToStaticMarkup(
    createElement(ContextBreakdown, { split: null, suggestions: [] }),
  );
  assert.match(html, /No context breakdown yet/);
  assert.match(html, /href="https:\/\/docs.ratel.sh"/);
});

test("the context breakdown shows each source as a meter with its waste", () => {
  const html = renderToStaticMarkup(
    createElement(ContextBreakdown, {
      split: {
        totalTokens: 18_000,
        runs: 60,
        rows: [
          {
            source: "history",
            label: "History",
            tokens: 11_000,
            share: 0.61,
            waste: { label: "re-read uncached", share: 1 },
          },
          { source: "tools", label: "Tools", tokens: 7_000, share: 0.39, waste: null },
        ],
      },
      suggestions: [
        {
          source: "history",
          severity: "high",
          title: "History keeps growing",
          hint: "",
          body: "History is 61% of input tokens.",
          perRunTokens: 180,
          manual: "Add a summarization step",
          ratel: "",
        },
      ],
    }),
  );
  assert.match(html, /18k<\/span> context/);
  assert.match(html, /role="meter" aria-label="History: share of context"[^>]*aria-valuenow="61"/);
  assert.match(html, /100%<\/span> re-read uncached/);
  assert.match(html, /Next step: <span[^>]*>Add a summarization step/);
});

test("a project with SDK events but no traces shows its searches and their days, not zero runs", () => {
  const sdkOnly = data({
    traces: aggregate({
      count: 0,
      errorCount: 0,
      errorRate: 0,
      p50DurationMs: null,
      p95DurationMs: null,
      costUsd: 0,
      totalTokens: 0,
    }),
    recentRuns: [],
    sdk: {
      current: { searches: 303, toolCalls: 303, skillRuns: 23 },
      previous: { searches: 101, toolCalls: 100, skillRuns: 0 },
      days: [
        { searches: 100, toolCalls: 100, skillRuns: 3 },
        { searches: 203, toolCalls: 203, skillRuns: 20 },
      ],
    },
  });
  const stats = overviewStats(sdkOnly, sdkOnly.traces!);
  assert.deepEqual(
    stats.map((stat) => [stat.label, stat.value]),
    [
      ["Searches", "303"],
      ["Tool calls", "303"],
      ["Skill runs", "23"],
    ],
  );
  assert.equal(stats[0]!.href, `${ROOT}/traces/logs?range=7d`);
  assert.equal(stats[0]!.delta?.value, "+200%");
  assert.ok(
    stats.every((stat) => stat.trend),
    "each with its days",
  );
  const html = render(sdkOnly);
  assert.match(html, /No traced runs yet/);
  assert.match(
    html,
    /<a[^>]*href="\/project\/p1\/traces\/logs\?range=7d"[^>]*>See SDK events<\/a>/,
  );
  assert.doesNotMatch(html, />Median duration</);
  assert.match(html, /At a glance/, "the product reads the same from the SDK");
});

test("with traces in the window the trace numbers stay, SDK events or not", () => {
  const both = data({
    sdk: { current: { searches: 50, toolCalls: 40, skillRuns: 0 }, previous: null, days: [] },
  });
  assert.equal(overviewStats(both, both.traces!)[0]!.label, "Runs");
});

test("names written from people's asks never sit in an attribute", () => {
  const html = render(
    data({
      attention: {
        items: [
          {
            key: "intent:t1",
            tone: "warning",
            mark: "intent",
            title: "Mostly unanswered",
            subject: { kind: "intent", name: "Equipment rental" },
            figure: { value: "0%", caption: "answered" },
            target: { kind: "link", href: `${ROOT}/intents?peek=t1` },
          },
        ],
        moreIssues: 0,
      },
    }),
  );
  for (const name of [
    "Schedule status",
    "Track material delivery",
    "Equipment rental",
    "search_docs",
  ]) {
    assert.ok(html.includes(name), `${name} is shown`);
    assert.ok(
      !attributeValues(html).some((value) => value.includes(name)),
      `${name} is in no attribute`,
    );
  }
});

test("the page speaks the product's nouns", () => {
  const text = visibleText(
    render(data({ project: { id: "p1", name: "Demo", slug: "demo", isDemo: true } })),
  );
  assert.doesNotMatch(text, /\btopics?\b|\bworkflows?\b|tool craft|suggestions?\b|\bsignals?\b/i);
});
