import { signalTitle } from "@/lib/readings/trace-signals/claims";
import type { PillarReading } from "@/lib/readings/trace-signals/health-pillars";
import {
  gainOf,
  type HealthScoreView,
  healthScoreView,
  type ScoredIssue,
} from "@/lib/readings/trace-signals/health-score";
import type { SignalKind } from "@/lib/readings/trace-signals/view";
import { errorResult, okResult, type ViewFixtures } from "../../shell/types";

/**
 * The health card's scenarios: get_agent_health as the tool returns it with
 * its view model (the `score`, each issue's `points` and the console's rows,
 * one per kind of issue). Scores and points are worked out by the console's
 * own `healthScoreView` and `gainOf`, so the numbers are the real ones for
 * these issues. Two kinds have two issues each, so a row can stand for
 * several. Reading times are
 * relative to when the harness loads the fixture.
 */

const PROJECT = "3f1c9a52-7d4e-4b8a-9c11-5e2d6f0a8b73";
const NOW = Date.now();
const HOUR = 3_600_000;
const AT = new Date(NOW - 6 * HOUR).toISOString();
const TURNS = 1730;

interface IssueSeed {
  id: string;
  kind: SignalKind;
  title: string;
  claim: string;
  cost: string;
  whatToDo: string;
  figure: string;
  caveat?: string;
  subject: { kind: string; label: string; tools: string[] };
  severity: number;
  /** Turns behind it, as the score reads them. */
  turns: number;
  hideable?: boolean;
}

const id = (n: number) => `9b7e0c1a-2f3d-4e5f-8a6b-${String(n).padStart(12, "0")}`;
const tool = (name: string) => ({ kind: "tool", label: name, tools: [name] });

const MANY: IssueSeed[] = [
  {
    id: id(1),
    kind: "error_loop",
    title: "refund_payment fails and the agent keeps retrying it",
    claim:
      "refund_payment errors in 8% of the turns that call it, and the agent calls it again in 3 of 4 of those.",
    cost: "About 340 turns this week ended without the refund.",
    whatToDo:
      "Return the payment provider's error message from refund_payment so the agent can tell the user instead of retrying.",
    figure: "8% of calls fail",
    subject: tool("refund_payment"),
    severity: 0.52,
    turns: 340,
  },
  {
    id: id(2),
    kind: "sibling_confusion",
    title: "get_order and get_order_status get mixed up",
    claim:
      "When the agent wants an order's status it picks get_order 41% of the time and then calls get_order_status anyway.",
    cost: "About 260 extra calls this week.",
    whatToDo:
      "Say in get_order's description that it returns line items, and in get_order_status's that it is the one for shipping status.",
    figure: "41% wrong first pick",
    subject: {
      kind: "tool_pair",
      label: "get_order ↔ get_order_status",
      tools: ["get_order", "get_order_status"],
    },
    severity: 0.41,
    turns: 260,
  },
  {
    id: id(3),
    kind: "empty_result",
    title: "search_kb returns nothing for 1 in 5 searches",
    claim:
      "search_kb returned no articles in 21% of its calls; those turns end with the agent guessing.",
    cost: "240 turns answered without an article.",
    whatToDo:
      "Add the missing help-center sections to the index, or let search_kb fall back to a looser match.",
    figure: "21% empty",
    subject: tool("search_kb"),
    severity: 0.36,
    turns: 240,
  },
  {
    id: id(4),
    kind: "unknown_tool",
    title: "The agent calls lookup_customer_v1, which no longer exists",
    claim: "161 turns called lookup_customer_v1. It is not in the tool list, so each call failed.",
    cost: "161 turns failed on their first step.",
    whatToDo:
      "Remove lookup_customer_v1 from the system prompt's examples; the tool is now lookup_customer.",
    figure: "161 failed calls",
    subject: tool("lookup_customer_v1"),
    severity: 0.3,
    turns: 161,
  },
  {
    id: id(5),
    kind: "buried_tool",
    title: "escalate_to_human sits below the top 5",
    claim:
      "When it is the right tool, escalate_to_human ranks 7th on average, and the agent picks it last.",
    cost: "54 turns took two or more detours before handing off.",
    whatToDo:
      "Name the cases it is for in escalate_to_human's description: angry customer, legal, refund over $500.",
    figure: "Rank 7 on average",
    subject: tool("escalate_to_human"),
    severity: 0.22,
    turns: 54,
  },
  {
    id: id(6),
    kind: "self_correcting",
    title: "The agent corrects itself after update_address",
    claim:
      "After update_address the agent says it made a mistake in 11% of turns, mostly a wrong postal code format.",
    cost: "38 turns with a correction.",
    whatToDo:
      "Accept postal codes with or without the space in update_address, and say which format it returns.",
    figure: "11% of turns",
    subject: tool("update_address"),
    severity: 0.15,
    turns: 38,
  },
  {
    id: id(7),
    kind: "latency_outlier",
    title: "search_orders is slow",
    claim: "search_orders takes 6.8 s at the median, 9 times longer than the agent's other tools.",
    cost: "About 24 minutes of waiting this week.",
    whatToDo: "Add an index on orders.customer_id, or cap the search to the last 90 days.",
    figure: "6.8 s median",
    caveat: "Slow on purpose? Hide it as slow by design and it stops counting.",
    subject: tool("search_orders"),
    severity: 0.4,
    turns: 210,
    hideable: true,
  },
  {
    id: id(8),
    kind: "magnet",
    title: "create_ticket shows up for asks it does not serve",
    claim: "create_ticket rides into 38% of tool lists and is picked in 2% of them.",
    cost: "About 300 searches carried it for nothing.",
    whatToDo:
      "Narrow create_ticket's description to new support tickets; it currently mentions orders and refunds.",
    figure: "38% of lists, 2% picked",
    subject: tool("create_ticket"),
    severity: 0.3,
    turns: 300,
  },
  {
    id: id(9),
    kind: "wait_heavy",
    title: "Turns wait on fetch_invoice_pdf",
    claim: "Turns that call fetch_invoice_pdf spend 72% of their time waiting on it.",
    cost: "80 turns over 20 s.",
    whatToDo: "Return a link to the PDF instead of its contents.",
    figure: "72% of turn time",
    subject: tool("fetch_invoice_pdf"),
    severity: 0.2,
    turns: 80,
    hideable: true,
  },
  {
    id: id(11),
    kind: "error_loop",
    title: "create_shipment fails and the agent keeps retrying it",
    claim:
      "create_shipment errors in 5% of the turns that call it, and the agent calls it again in 2 of 3 of those.",
    cost: "About 120 turns this week ended without a shipment.",
    whatToDo:
      "Return the carrier's error from create_shipment, and say which fields to change before a retry.",
    figure: "5% of calls fail",
    subject: tool("create_shipment"),
    severity: 0.34,
    turns: 120,
  },
  {
    id: id(12),
    kind: "latency_outlier",
    title: "export_invoices is slow",
    claim:
      "export_invoices takes 4.1 s at the median, 5 times longer than the agent's other tools.",
    cost: "About 9 minutes of waiting this week.",
    whatToDo: "Page the export, or return a link to a file that is built in the background.",
    figure: "4.1 s median",
    caveat: "Slow on purpose? Hide it as slow by design and it stops counting.",
    subject: tool("export_invoices"),
    severity: 0.22,
    turns: 95,
    hideable: true,
  },
  {
    id: id(10),
    kind: "dead_tool",
    title: "legacy_export is never called",
    claim: "legacy_export was listed 410 times this week and never called.",
    cost: "One more tool in every list the agent reads.",
    whatToDo: "Retire legacy_export, or say what it is for.",
    figure: "0 calls",
    subject: tool("legacy_export"),
    severity: 0.5,
    turns: 0,
  },
];

const PILLARS_OK: PillarReading[] = [
  { pillar: "ended", good: 0.71, n: 1730 },
  { pillar: "top_5", good: 0.79, n: 1610 },
  { pillar: "corrections", good: 0.86, n: 1730 },
  { pillar: "tasks", good: 0.58, n: 902 },
  { pillar: "calls", good: 0.88, n: 4210 },
];

const PILLARS_GREAT: PillarReading[] = [
  { pillar: "ended", good: 0.97, n: 2104 },
  { pillar: "top_5", good: 0.98, n: 1980 },
  { pillar: "corrections", good: 0.99, n: 2104 },
  { pillar: "tasks", good: 0.95, n: 1210 },
  { pillar: "calls", good: 0.99, n: 5320 },
];

function issueRow(seed: IssueSeed, score: HealthScoreView | null) {
  return {
    id: seed.id,
    kind: seed.kind,
    title: seed.title,
    claim: seed.claim,
    cost: seed.cost,
    whatToDo: seed.whatToDo,
    figure: seed.figure,
    caveat: seed.caveat ?? null,
    subject: {
      kind: seed.subject.kind,
      label: seed.subject.label,
      tools: seed.subject.tools.map((name) => ({ id: name, label: name })),
    },
    tier: "deterministic",
    severity: seed.severity,
    impact: seed.turns * 2,
    n: seed.turns,
    hideable: seed.hideable ?? false,
    points: score ? gainOf(score, [seed.id]) : null,
    firstSeenAt: "2026-11-02T08:00:00.000Z",
    lastSeenAt: AT,
    href: `/project/${PROJECT}/health?peek=issue:${seed.id}`,
  };
}

/**
 * The console's rows for these issues (`issueRows` in
 * `components/health/v2/issue-rows.ts`): one per kind, its issues worst first,
 * worth what fixing all of them wins back, the most points first.
 */
function rowsOf(seeds: readonly IssueSeed[], score: HealthScoreView | null) {
  const byKind = new Map<SignalKind, IssueSeed[]>();
  for (const seed of [...seeds].sort((a, b) => b.severity - a.severity))
    byKind.set(seed.kind, [...(byKind.get(seed.kind) ?? []), seed]);
  const rows = [...byKind.entries()].map(([kind, members]) => {
    const named = members.map((member) => member.subject.tools);
    const shown = named.slice(0, named.every((names) => names.length === 1) ? 2 : 1);
    return {
      key: kind,
      kind,
      title: signalTitle(kind),
      tone: members[0]!.severity >= 0.4 ? "fix_now" : "watch",
      tools: { shown, more: named.length - shown.length, count: null },
      scope: null,
      about:
        shown.map((names) => names.join(" → ")).join(", ") +
        (named.length > shown.length ? ` +${named.length - shown.length}` : ""),
      figure: { display: members[0]!.figure, caption: "" },
      memberIds: members.map((member) => member.id),
      points: score
        ? gainOf(
            score,
            members.map((member) => member.id),
          )
        : null,
    };
  });
  return score ? [...rows].sort((a, b) => (b.points ?? 0) - (a.points ?? 0)) : rows;
}

function issuesLine(
  rows: readonly { memberIds: readonly string[] }[],
  seeds: readonly IssueSeed[],
  scored: boolean,
): string {
  const tools = new Set(seeds.flatMap((seed) => seed.subject.tools)).size;
  return `${rows.length} ${rows.length === 1 ? "issue" : "issues"} across ${tools} ${tools === 1 ? "tool" : "tools"}, ${scored ? "most points first" : "worst first"}.`;
}

function scoreOf(
  seeds: readonly IssueSeed[],
  turns: number,
  history: number[],
  pillars: PillarReading[],
) {
  const issues: ScoredIssue[] = seeds.map((seed) => ({
    id: seed.id,
    kind: seed.kind,
    severity: seed.severity,
    turns: seed.turns,
  }));
  return healthScoreView(
    issues,
    turns,
    history.map((value) => ({ version: 2, value })),
    pillars,
  );
}

const SHAPES = [
  { shape: "direct", label: "Direct", share: 0.58, count: 1003 },
  { shape: "detour", label: "Detour", share: 0.21, count: 363 },
  { shape: "retry", label: "Retry", share: 0.11, count: 190 },
  { shape: "dead_end", label: "Dead end", share: 0.07, count: 121 },
  { shape: "blind", label: "Blind", share: 0.03, count: 53 },
];

function health(options: {
  turns: number;
  readiness: "no_telemetry" | "collecting" | "ready";
  state: { kind: string; title: string; body: string };
  issues: IssueSeed[];
  hidden?: { id: string; kind: SignalKind; toolId: string; label: string }[];
  score: HealthScoreView | null;
  shapes?: typeof SHAPES;
  computedAt?: string;
}) {
  const score = options.score;
  return {
    windowDays: 7,
    windowOptions: [7, 30, 90],
    readiness: options.readiness,
    state: options.state,
    turns: options.turns,
    floor: 200,
    computedAt: options.readiness === "no_telemetry" ? null : (options.computedAt ?? AT),
    signalWindowDays: 7,
    sourceMode: "sdk",
    captureLevel: "content",
    captureUnlocks: [],
    setup: null,
    tiles: [],
    shapes: options.shapes ?? [],
    tasks: null,
    openIssueCount: options.issues.length,
    issues: options.issues.map((seed) => issueRow(seed, score)),
    lockedIssueCount: 0,
    tooEarly: [],
    hiddenIssues: options.hidden ?? [],
    exampleTurnsPerIssue: 5,
    imports: [],
    href: `/project/${PROJECT}/health?days=7`,
    // As get_agent_health sends it: the page's view without its per-issue parts.
    score: score ? (({ parts: _parts, ...rest }) => rest)(score) : null,
    rows: rowsOf(options.issues, score),
    line: issuesLine(rowsOf(options.issues, score), options.issues, score !== null),
  };
}

/**
 * A get_agent_health result as the server sends it: the score, each issue's
 * points and the rows ride in the view model (`_meta`), never in the data the
 * agent reads.
 */
function healthResult(
  full: ReturnType<typeof health>,
  extra: Record<string, unknown> = {},
  viewExtra: Record<string, unknown> = {},
) {
  const { score, issues, rows, line, ...rest } = full;
  const data = { ...rest, issues: issues.map(({ points: _points, ...issue }) => issue) };
  const points = Object.fromEntries(
    issues.flatMap((issue) => (issue.points === null ? [] : [[issue.id, issue.points]])),
  );
  return okResult(data, {
    ...extra,
    view: {
      kind: "health_score",
      score,
      points,
      rows,
      line,
      early: false,
      progress: null,
      ...viewExtra,
    },
  });
}

const HIDDEN = [
  { id: id(20), kind: "latency_outlier" as const, toolId: "sync_crm", label: "sync_crm is slow" },
];

/** Example turns for every issue: the harness answers tools/call by name, not by arguments. */
function examplesFor(seeds: readonly IssueSeed[]) {
  const queries = [
    "where is my order 4821",
    "refund the duplicate charge",
    "change my delivery address",
    "talk to a person please",
    "invoice for october",
  ];
  return seeds.map((seed, issueIndex) => ({
    id: seed.id,
    total: seed.turns,
    turns: [0, 1, 2].map((turnIndex) => {
      const target = seed.subject.tools[0] ?? "search_kb";
      const query = queries[(issueIndex + turnIndex) % queries.length];
      const failing = ["error_loop", "unknown_tool", "empty_result"].includes(seed.kind);
      return {
        turnId: `turn-${issueIndex}-${turnIndex}`,
        traceId: `5a${issueIndex}${turnIndex}e1c0ffee${issueIndex}${turnIndex}`,
        startedAt: new Date(
          Date.parse(AT) - (issueIndex * 7 + turnIndex * 3 + 1) * 3_600_000,
        ).toISOString(),
        turnSource: "user",
        steps: [
          { kind: "search", query, queryState: "captured", listed: 8, flag: null },
          ...(seed.kind === "sibling_confusion"
            ? [
                {
                  kind: "invoke",
                  toolId: "get_order",
                  pickedRank: 1,
                  outcome: "ok",
                  tookMs: 310,
                  flag: "Picked the wrong one",
                },
              ]
            : []),
          {
            kind: "invoke",
            toolId: target,
            pickedRank: seed.kind === "buried_tool" ? 7 : 2,
            outcome: failing ? "error" : "ok",
            tookMs:
              seed.kind === "latency_outlier"
                ? 6800 + turnIndex * 900
                : seed.kind === "wait_heavy"
                  ? 14200
                  : 420,
            flag: seed.kind === "sibling_confusion" ? null : seed.figure,
          },
          ...(seed.kind === "error_loop"
            ? [
                {
                  kind: "invoke",
                  toolId: target,
                  pickedRank: 2,
                  outcome: "error",
                  tookMs: 380,
                  flag: "Retried",
                },
              ]
            : []),
        ],
        href: `/project/${PROJECT}/traces?turn=turn-${issueIndex}-${turnIndex}`,
      };
    }),
  }));
}

const manyScore = scoreOf(MANY, TURNS, [66, 69, 71, 70, 72], PILLARS_OK);

const READY_STATE = { kind: "ready", title: "", body: "" };

const manyIssues = health({
  turns: TURNS,
  readiness: "ready",
  state: READY_STATE,
  issues: MANY,
  hidden: HIDDEN,
  score: manyScore,
  shapes: SHAPES,
});

const MANY_CALLS = {
  list_issue_examples: okResult({ locked: false, turnsPerIssue: 5, examples: examplesFor(MANY) }),
  set_health_signal_hidden: okResult({ id: id(7), kind: "latency_outlier", hidden: true }),
  // The card reads the tool again after a write and once a fresh reading is in.
  get_agent_health: healthResult(manyIssues),
  request_analysis: okResult({ what: "health", queued: true, jobId: "job-81", coalesced: false }),
  get_analysis_freshness: okResult({
    updatedAt: new Date(NOW + 10 * 60_000).toISOString(),
    working: false,
    importing: null,
    line: "Analysis updated just now",
    section: {
      name: "health",
      lastDoneAt: new Date(NOW + 10 * 60_000).toISOString(),
      pending: 0,
      jobKinds: [],
    },
  }),
};

const fixtures: ViewFixtures = {
  "many-issues": {
    tool: "get_agent_health",
    input: { projectId: PROJECT, windowDays: 7 },
    result: healthResult(manyIssues, {
      hint: "list_issue_examples with issue ids shows the turns behind an issue.",
    }),
    calls: MANY_CALLS,
  },
  healthy: {
    tool: "get_agent_health",
    input: { projectId: PROJECT, windowDays: 7 },
    result: healthResult(
      health({
        turns: 2104,
        readiness: "ready",
        state: READY_STATE,
        issues: [],
        hidden: HIDDEN,
        score: scoreOf([], 2104, [93, 91, 88], PILLARS_GREAT),
      }),
    ),
    calls: {
      set_health_signal_hidden: okResult({ id: id(20), kind: "latency_outlier", hidden: false }),
    },
  },
  empty: {
    tool: "get_agent_health",
    input: { projectId: PROJECT, windowDays: 7 },
    result: healthResult(
      health({
        turns: 0,
        readiness: "no_telemetry",
        state: {
          kind: "nothing_yet",
          title: "No runs yet",
          body: "Agent health reads your agent's turns. Send traces with the Ratel SDK and the first reading starts on its own.",
        },
        issues: [],
        score: null,
      }),
    ),
  },
  stale: {
    tool: "get_agent_health",
    input: { projectId: PROJECT, windowDays: 7 },
    result: healthResult(
      health({
        turns: TURNS,
        readiness: "ready",
        state: READY_STATE,
        issues: MANY,
        hidden: HIDDEN,
        score: manyScore,
        computedAt: new Date(NOW - 3 * 24 * HOUR).toISOString(),
      }),
    ),
    calls: MANY_CALLS,
  },
  // The first reading is still going: the score is provisional, with no change against a full reading.
  "early-reading": {
    tool: "get_agent_health",
    input: { projectId: PROJECT, windowDays: 7 },
    result: healthResult(
      manyIssues,
      {},
      { early: true, progress: { read: 420, total: 1730, percent: 24 } },
    ),
    calls: MANY_CALLS,
  },
  "too-few": {
    tool: "get_agent_health",
    input: { projectId: PROJECT, windowDays: 7 },
    result: healthResult(
      health({
        turns: 64,
        readiness: "collecting",
        state: {
          kind: "too_few",
          title: "Too early to call",
          body: "64 turns so far. A reading needs 200 to say anything you can trust.",
        },
        issues: [],
        score: null,
      }),
    ),
    calls: {
      request_analysis: okResult({
        what: "health",
        queued: true,
        jobId: "job-81",
        coalesced: false,
      }),
    },
  },
  "score-off": {
    tool: "get_agent_health",
    input: { projectId: PROJECT, windowDays: 7 },
    result: healthResult(
      health({
        turns: TURNS,
        readiness: "ready",
        state: READY_STATE,
        issues: MANY,
        hidden: HIDDEN,
        score: null,
      }),
    ),
    calls: MANY_CALLS,
  },
  loading: { tool: "get_agent_health", input: { projectId: PROJECT, windowDays: 7 } },
  error: {
    tool: "get_agent_health",
    result: errorResult("forbidden", "Agent health is not available for this project."),
  },
};

export default fixtures;
