import { healthScoreView } from "@/lib/readings/trace-signals/health-score";
import type { FocusedOverviewData } from "@/lib/views/home/focused-load";
import type { ChangeSource } from "@/lib/views/overview-layout/domain/history";
import {
  changeLayout,
  DEFAULT_LAYOUT,
  type OverviewLayout,
  type OverviewWidgetId,
  onlyWidget,
  WIDGET_CATALOG,
} from "@/lib/views/overview-layout/domain/layout";
import { errorResult, okResult, type ViewFixture, type ViewFixtures } from "../../shell/types";

/** The scenarios of the Overview's tools, with the view model that the server sends. */

const PROJECT = "3f1c9a52-7d4e-4b8a-9c11-5e2d6f0a8b73";
const ROOT = `/project/${PROJECT}`;
const HEALTH = `${ROOT}/health?days=7`;
const DAYS = [18, 24, 21, 30, 12, 9, 27];

const node = (
  kind: "agent" | "mcp",
  key: string,
  count: number,
  errorRate = 0,
): Extract<FocusedOverviewData["topology"], object>["nodes"][number] => ({
  id: `${kind}:${key}`,
  kind,
  key,
  name: key,
  count,
  errorRate,
  failing: errorRate > 0.1,
});

const DATA: Omit<FocusedOverviewData, "lastEventAt"> = {
  project: { id: PROJECT, name: "Support agent", slug: "support-agent", isDemo: false },
  root: ROOT,
  window: 7,
  rangeParam: "7d",
  telemetryRead: true,
  hasTelemetry: true,
  layout: DEFAULT_LAYOUT,
  metrics: {
    root: ROOT,
    window: 7,
    rangeParam: "7d",
    traces: {
      count: 141,
      errorCount: 7,
      errorRate: 7 / 141,
      p50DurationMs: 4_200,
      p95DurationMs: 11_000,
      p99DurationMs: 18_000,
      costUsd: 3.84,
      totalTokens: 1_240_000,
      volume: [],
    },
    previous: {
      count: 120,
      errorCount: 9,
      errorRate: 0.075,
      p50DurationMs: 4_600,
      p95DurationMs: 12_000,
      p99DurationMs: 19_000,
      costUsd: 3.1,
      totalTokens: 1_010_000,
      volume: [],
    },
    series: DAYS,
    daily: {
      failedShare: DAYS.map((runs) => 1 / runs),
      duration: DAYS.map((runs) => 3_000 + runs * 60),
      spend: DAYS.map((runs) => runs * 0.027),
    },
    sdk: null,
    health: null,
  },
  topology: {
    nodes: [
      node("agent", "support", 141, 0.05),
      node("agent", "billing", 38, 0.13),
      node("mcp", "orders", 212, 0.01),
      node("mcp", "payments", 61, 0.14),
    ],
    edges: [
      { kind: "handoff", from: "agent:support", to: "agent:billing", count: 38, errors: null },
      { kind: "call", from: "agent:support", to: "mcp:orders", count: 212, errors: 2 },
      { kind: "call", from: "agent:billing", to: "mcp:payments", count: 61, errors: 9 },
    ],
    omitted: { agents: 0, servers: 0, atLeast: false },
  },
  health: {
    href: HEALTH,
    windowDays: 7,
    card: {
      kind: "score",
      score: healthScoreView(
        [{ id: "i1", kind: "error_loop", severity: 0.5, turns: 200 }] as never,
        1_000,
        [],
        [],
      ),
      early: false,
      lowConfidence: null,
      lost: [],
    },
  },
  attention: {
    items: [
      {
        key: "errors",
        tone: "danger",
        mark: "run",
        title: "Failed runs",
        subject: null,
        figure: { value: "5%", caption: "7 of 141" },
        target: { kind: "link", href: `${ROOT}/traces?range=7d&errorOnly=1` },
      },
      {
        key: "issue:i1",
        tone: "warning",
        mark: "issue",
        title: "Retries after errors",
        subject: { kind: "tools", tools: [{ name: "refund_payment", skill: false }], more: 1 },
        figure: { value: "34", caption: "errors" },
        target: { kind: "link", href: `${HEALTH}&peek=issue%3Ai1#signal-i1` },
      },
      {
        key: "context:tools",
        tone: "info",
        mark: "context",
        title: "Tools never called",
        subject: null,
        figure: { value: "62%", caption: "of tools" },
        target: { kind: "peek", peek: "context" },
      },
    ],
    moreIssues: 2,
    healthHref: HEALTH,
    partial: false,
  },
  alerts: {
    items: [
      {
        id: "a1",
        name: "Too many errors",
        value: "12%",
        condition: "above 5%",
        since: "12m ago",
        href: `${ROOT}/alerts/a1`,
      },
    ],
    href: `${ROOT}/alerts`,
  },
  dashboards: null,
  context: null,
};

function fixture(
  over: Partial<Omit<FocusedOverviewData, "lastEventAt">> = {},
  layout: OverviewLayout = DEFAULT_LAYOUT,
): ViewFixture {
  const overview = { ...DATA, ...over, layout, lastEventAt: "2026-11-24T10:00:00.000Z" };
  return {
    tool: "get_overview",
    result: okResult(
      { project: { id: PROJECT, name: DATA.project.name }, range: "7d" },
      { view: { kind: "overview", overview, linked: true } },
    ),
  };
}

/** One widget, as the server sends it: the others are not read. */
function single(
  widget: OverviewWidgetId,
  over: Partial<Omit<FocusedOverviewData, "lastEventAt">> = {},
): ViewFixture {
  const entry = WIDGET_CATALOG.find(({ id }) => id === widget);
  if (!entry) throw new Error(`no widget ${widget}`);
  const overview = {
    ...DATA,
    metrics: null,
    topology: null,
    health: null,
    attention: null,
    alerts: null,
    [widget]: DATA[widget],
    ...over,
    layout: onlyWidget(entry),
    lastEventAt: "2026-11-24T10:00:00.000Z",
  };
  return {
    tool: "get_overview",
    input: { widget },
    result: okResult(
      { project: { id: PROJECT, name: DATA.project.name }, range: "7d", widget },
      { view: { kind: "overview", overview, linked: true, widget } },
    ),
  };
}

const ARRANGED = changeLayout(
  changeLayout(DEFAULT_LAYOUT, { kind: "remove", widget: "topology" }),
  {
    kind: "move",
    widget: "attention",
    x: 4,
    y: 0,
  },
);

const entry = (
  id: number,
  minutes: number,
  summary: string,
  source: ChangeSource = { kind: "web" },
) => ({
  id,
  source,
  summary,
  readable: id !== 2,
  current: id === 4,
  at: new Date(Date.parse("2026-11-24T10:00:00.000Z") - minutes * 60_000).toISOString(),
});

function history(entries: readonly ReturnType<typeof entry>[]): ViewFixture {
  const project = { id: PROJECT, name: DATA.project.name };
  return {
    tool: "list_overview_changes",
    result: okResult(
      { project, changes: entries.map(({ summary, ...rest }) => ({ ...rest, what: summary })) },
      {
        view: {
          kind: "overview-history",
          project,
          root: ROOT,
          now: "2026-11-24T10:00:00.000Z",
          entries,
        },
      },
    ),
  };
}

const fixtures: ViewFixtures = {
  get_overview: fixture(),
  "get_overview · removed widget": fixture({ topology: null }, ARRANGED),
  "get_overview · no score": fixture({
    health: {
      href: HEALTH,
      windowDays: 7,
      card: {
        kind: "state",
        line: "Too few turns: 12 of the 50 a score needs.",
        failed: false,
      },
    },
  }),
  "get_overview · no data": fixture({ hasTelemetry: false, metrics: null }),
  "get_overview · failed reads": fixture({ metrics: "failed", topology: "failed" }),
  "get_overview · metrics": single("metrics"),
  "get_overview · topology": single("topology"),
  "get_overview · health": single("health"),
  "get_overview · attention": single("attention"),
  "get_overview · attention, nothing": single("attention", {
    attention: { items: [], moreIssues: 0, healthHref: HEALTH, partial: false },
  }),
  "get_overview · alerts": single("alerts"),
  "get_overview · alerts, none": single("alerts", {
    alerts: { items: [], href: `${ROOT}/alerts` },
  }),
  "get_overview · topology, failed read": single("topology", { topology: "failed" }),
  "get_overview · metrics, no data": single("metrics", { hasTelemetry: false, metrics: null }),
  "get_overview · unknown widget": {
    tool: "get_overview",
    input: { widget: "spend" },
    result: errorResult(
      "invalid_params",
      'The Overview has no widget with the name "spend". The widgets are: metrics, topology, health, attention, alerts.',
    ),
  },
  change_overview_layout: {
    ...fixture({ topology: null }, ARRANGED),
    tool: "change_overview_layout",
  },
  list_overview_changes: history([
    entry(4, 0, "Took back: Removed Metrics"),
    entry(3, 4, "Removed Metrics", { kind: "mcp", client: "claude-code" }),
    entry(2, 90, "Moved Needs attention", { kind: "mcp", client: null }),
    entry(1, 2_000, "Resized Agents and MCP servers"),
  ]),
  "list_overview_changes · none": history([]),
  undo_overview_change: { ...fixture(), tool: "undo_overview_change", input: { revision: "3.a" } },
  restore_overview_layout: {
    ...fixture({ topology: null }, ARRANGED),
    tool: "restore_overview_layout",
    input: { changeId: 2, revision: "4.b" },
  },
  "undo_overview_change · stale": {
    tool: "undo_overview_change",
    input: { revision: "3.a" },
    result: errorResult(
      "conflict",
      "The layout changed in another place. Nothing was overwritten. Call list_overview_changes to read the latest changes and the revision.",
    ),
  },
  "get_overview · text only": {
    tool: "get_overview",
    result: okResult({ project: { id: PROJECT, name: DATA.project.name }, range: "7d" }),
  },
  "get_overview · flag off": {
    tool: "get_overview",
    result: errorResult("forbidden", "The Overview is not available for this project."),
  },
};

export default fixtures;
