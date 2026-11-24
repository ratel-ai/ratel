import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AttentionList } from "@/components/console/home/AttentionList";
import { ContextBreakdown } from "@/components/console/home/ContextBreakdown";
import { focusedStats } from "@/components/console/home/overview-stats";
import type { HealthTile } from "@/lib/readings/trace-signals/view";
import type { TraceAggregateSummary } from "@/lib/synthesis/traces/queries";
import type { AttentionItem } from "@/lib/views/home/attention";
import type { MetricsData } from "@/lib/views/home/focused-load";

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

const ISSUE: AttentionItem = {
  key: "issue:a",
  tone: "warning",
  mark: "issue",
  title: "Wrong tool keeps showing up",
  subject: { kind: "tools", tools: [{ name: "create_task", skill: false }], more: 2 },
  figure: { value: "41%", caption: "of lists" },
  target: { kind: "link", href: `${ROOT}/health?peek=issue%3Aa#signal-a` },
};

function data(overrides: Partial<MetricsData> = {}): MetricsData {
  return {
    root: ROOT,
    window: 7,
    rangeParam: "7d",
    traces: aggregate(),
    previous: aggregate({ count: 100, errorRate: 0.03, p50DurationMs: 2_000, costUsd: 4 }),
    series: [10, 20, 15, 20, 25, 10, 20],
    daily: {
      failedShare: [0.1, 0, 0.05, null, 0.02, 0, 0.1],
      duration: [1_000, 1_200, 900, null, 2_000, 1_500, 1_800],
      spend: [0.5, 0.6, 0.4, null, 0.9, 0.7, 1.1],
    },
    health: null,
    sdk: null,
    ...overrides,
  };
}

const render = (...items: AttentionItem[]) =>
  renderToStaticMarkup(createElement(AttentionList, { items }));

/** Every attribute value in the markup. */
function attributeValues(html: string): string[] {
  return [...html.matchAll(/\s[\w-]+="([^"]*)"/g)].map((match) => match[1]!);
}

test("Needs attention is a row per thing: its mark, a few words, its pins, one number, a chevron", () => {
  const html = render(ISSUE);
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

test("rows about a task or an intent carry its pin", () => {
  const html = render(
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

test("stats carry their changes, links and sparks, and no sentences", () => {
  const [runs, failed, duration, spend] = focusedStats(data());
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
  const [runs, failed, duration, spend] = focusedStats(
    data({
      traces: aggregate({ count: 0 }),
      series: [0, 0, 0, 0, 0, 0, 0],
      daily: { failedShare: [], duration: [null], spend: [0, 0] },
    }),
  );
  for (const stat of [runs, failed, duration, spend])
    assert.equal(stat.trend, undefined, stat.label);
  assert.equal(runs.hint, "None in the last 7 days");
});

test("no baseline means no change figure", () => {
  const [runs, failed] = focusedStats(
    data({ previous: aggregate({ count: 0, errorRate: 0, costUsd: 0 }) }),
  );
  assert.equal(runs.delta, undefined);
  assert.equal(failed.delta, undefined);
  const [unread, , , spend] = focusedStats(data({ previous: null }));
  assert.equal(unread.delta, undefined);
  assert.equal(spend.delta, undefined);
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

const SDK_ONLY = data({
  traces: aggregate({ count: 0, errorCount: 0, errorRate: 0, p50DurationMs: null, costUsd: 0 }),
  sdk: {
    current: { searches: 303, toolCalls: 303, skillRuns: 23 },
    previous: { searches: 101, toolCalls: 100, skillRuns: 0 },
    days: [
      { searches: 100, toolCalls: 100, skillRuns: 3 },
      { searches: 203, toolCalls: 203, skillRuns: 20 },
    ],
  },
});

test("first try shows for a project without runs, with its days", () => {
  const health = { href: `${ROOT}/health`, windowDays: 7 as const, firstTry: FIRST_TRY };
  const [, firstTry] = focusedStats({ ...SDK_ONLY, window: 30, health });
  assert.equal(firstTry!.label, "First try");
  assert.equal(firstTry!.value, "64%");
  assert.deepEqual(firstTry!.delta, {
    value: "-5 pts",
    direction: "down",
    good: false,
    label: "vs previous 7 days",
  });
  assert.equal(firstTry!.hint, "Last 7 days", "said only when the plan reads another window");
  assert.equal(firstTry!.href, `${ROOT}/health`);
  const spark = renderToStaticMarkup(createElement("div", null, firstTry!.trend));
  assert.match(spark, /aria-label="First try per day, last 7 days"/);
  assert.match(spark, /data-gap=""/, "a day without turns is a gap");
  assert.equal(focusedStats({ ...SDK_ONLY, health })[1]!.hint, undefined);
  assert.equal(focusedStats(data({ health }))[1]!.label, "Failed runs", "not with runs");
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
  const stats = focusedStats(SDK_ONLY);
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
});

test("with traces in the window the trace numbers stay, SDK events or not", () => {
  assert.equal(focusedStats({ ...SDK_ONLY, traces: aggregate() })[0]!.label, "Runs");
});

test("names written from people's asks never sit in an attribute", () => {
  const html = render({
    ...ISSUE,
    mark: "intent",
    subject: { kind: "intent", name: "Equipment rental" },
  });
  assert.ok(html.includes("Equipment rental"));
  assert.ok(!attributeValues(html).some((value) => value.includes("Equipment rental")));
});
