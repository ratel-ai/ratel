/**
 * Deterministic fixture data for the generic views, shaped exactly as the
 * tools return it (lib/mcp/operations: list_traces, get_trace, list_intents,
 * get_intent, get_cost_by_day). Names follow the seed demo's support agent
 * (lib/seed/intents-demo.ts).
 */

/** A small seeded generator, so screenshots do not change between runs. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const ROOTS = [
  "support.chat",
  "billing.refund",
  "orders.lookup",
  "kb.answer",
  "handoff.escalate",
  "account.update",
];
const SERVICES = ["support-agent", "billing-agent"];
const NOW = Date.parse("2026-11-11T14:00:00Z");

export function traces(count: number, seed = 7) {
  const random = seeded(seed);
  return Array.from({ length: count }, (_, index) => {
    const failed = random() < 0.12;
    const tokens = Math.round(2_000 + random() * 38_000);
    const unpriced = random() < 0.08;
    return {
      traceId: Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16)).join(""),
      rootName: ROOTS[Math.floor(random() * ROOTS.length)],
      serviceName: SERVICES[index % 5 === 0 ? 1 : 0],
      startedAt: new Date(NOW - index * 7 * 60_000 - Math.floor(random() * 300_000)).toISOString(),
      durationMs: Math.round(300 + random() * 24_000),
      statusCode: failed ? 2 : 1,
      spanCount: 3 + Math.floor(random() * 22),
      errorCount: failed ? 1 + Math.floor(random() * 2) : 0,
      totalTokens: tokens,
      costUsd: unpriced ? null : Math.round(tokens * 0.0000031 * 1e6) / 1e6,
      experimentName: index % 4 === 0 ? "rerank-v2" : null,
      experimentArm: index % 4 === 0 ? (index % 8 === 0 ? "candidate" : "baseline") : null,
    };
  });
}

export function traceDetail(traceId: string, seed = 11, count = 7) {
  const random = seeded(seed);
  const pattern = [
    { name: "agent.turn", step: "agent" },
    { name: "llm.chat claude-sonnet", step: "model", model: "claude-sonnet-5-5" },
    { name: "ratel.search", step: "search" },
    { name: "tool lookup_order", step: "tool", toolName: "lookup_order" },
    { name: "tool refund_payment", step: "tool", toolName: "refund_payment" },
    { name: "llm.chat claude-sonnet", step: "model", model: "claude-sonnet-5-5" },
    { name: "tool send_email", step: "tool", toolName: "send_email" },
  ];
  // A longer run repeats the turn: agent, model, search, tools, model…
  const steps = Array.from({ length: count }, (_, index) =>
    index < pattern.length ? pattern[index] : pattern[1 + ((index - 1) % (pattern.length - 1))],
  );
  return {
    traceId,
    spanCount: steps.length,
    spans: steps.map((step, index) => ({
      spanId: `span${index}`,
      parentSpanId: index === 0 ? null : "span0",
      name: step.name,
      kind: "INTERNAL",
      statusCode: index === 4 ? 2 : 1,
      startedAt: new Date(NOW - 60_000 + index * 900).toISOString(),
      durationMs: Math.round(40 + random() * 2_400),
      serviceName: "support-agent",
      inputTokens: step.step === "model" ? Math.round(3_000 + random() * 9_000) : null,
      outputTokens: step.step === "model" ? Math.round(200 + random() * 900) : null,
      step: step.step,
      ...(step.model ? { model: step.model, costUsd: Math.round(random() * 40_000) / 1e6 } : {}),
      ...(step.toolName ? { toolName: step.toolName } : {}),
      ...(index === 4 ? { errorType: "PaymentDeclined" } : {}),
    })),
  };
}

const INTENT_NAMES = [
  "Refund a duplicate charge",
  "Track an order",
  "Change the delivery address",
  "Cancel a subscription",
  "Reset a password",
  "Update payment method",
  "Ask about a missing item",
  "Request an invoice",
  "Report a damaged product",
  "Apply a discount code",
  "Ask about shipping times",
  "Close the account",
];

export function intents(count: number, seed = 3) {
  const random = seeded(seed);
  let left = 1;
  return Array.from({ length: count }, (_, index) => {
    const share =
      index === count - 1 ? left : Math.round(left * (0.18 + random() * 0.2) * 1000) / 1000;
    left = Math.max(0, left - share);
    const turns = Math.round(share * 4_200);
    const answeredShare = Math.round((0.45 + random() * 0.5) * 1000) / 1000;
    return {
      id: `intent-${index + 1}`,
      name:
        INTENT_NAMES[index % INTENT_NAMES.length] +
        (index >= INTENT_NAMES.length ? ` (${Math.floor(index / INTENT_NAMES.length) + 1})` : ""),
      description:
        "People ask the agent to do this in their own words; the reading groups those asks.",
      turns,
      share,
      asks: Math.round(turns * 0.8),
      conversations: Math.round(turns * 0.6),
      answered: Math.round(turns * answeredShare),
      answeredShare,
      mostlyUnanswered: answeredShare < 0.55,
      // As list_intents sends it (lib/topics/view.ts TopicView.sentiment).
      sentiment: (() => {
        const measured = Math.max(1, Math.round(turns * 0.8));
        const negative = Math.round(measured * random() * 0.3);
        const positive = Math.round((measured - negative) * 0.5);
        return {
          positive,
          neutral: measured - negative - positive,
          negative,
          measured,
          negativeShare: Math.round((negative / measured) * 1000) / 1000,
        };
      })(),
      tasks: [
        {
          id: `task-${index}-a`,
          name: "Issue the refund",
          turns: Math.round(turns * 0.6),
          share: 0.6,
        },
        {
          id: `task-${index}-b`,
          name: "Explain the policy",
          turns: Math.round(turns * 0.3),
          share: 0.3,
        },
      ],
      untasked: Math.round(turns * 0.1),
      tools: [
        { id: "lookup_order", calls: Math.round(turns * 1.2), failures: 4, failureShare: 0.008 },
        { id: "refund_payment", calls: Math.round(turns * 0.5), failures: 31, failureShare: 0.12 },
      ],
      selfCorrections: Math.round(random() * 40),
      askedAgain: Math.round(random() * 60),
      askedNext: [],
      trend: null,
      href: `/projects/demo/intents/intent-${index + 1}`,
    };
  });
}

export function intentDetail(intent: ReturnType<typeof intents>[number], withheld = false) {
  return {
    intent: withheld ? { ...intent, description: null } : intent,
    breakdown: null,
    steps: { status: "ready" },
    exampleAsks: [
      {
        text: withheld ? null : "I was charged twice for order 4821, can you refund one?",
        source: "conversation",
        href: null,
      },
      {
        text: withheld ? null : "Why do I see two payments for the same thing?",
        source: "conversation",
        href: null,
      },
      {
        text: withheld ? null : "Refund the extra charge please",
        source: "conversation",
        href: null,
      },
    ],
    links: [],
    ...(withheld ? { contentWithheld: true } : {}),
  };
}

export function costByDay(days: number, seed = 5) {
  const random = seeded(seed);
  const start = Date.parse("2026-11-11T00:00:00Z") - (days - 1) * 86_400_000;
  return Array.from({ length: days }, (_, index) => {
    const weekend = new Date(start + index * 86_400_000).getUTCDay() % 6 === 0;
    const runs = Math.round(
      (weekend ? 120 : 380) * (0.75 + random() * 0.5) * (1 + index / (days * 2)),
    );
    return {
      day: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
      spend: {
        skills: runs * 900,
        tools: runs * 2_400,
        history: runs * 5_100,
        memory: runs * 300,
        user_input: runs * 200,
      },
      splits: {
        history_cached: runs * 3_000,
        history_uncached: runs * 2_100,
        tools_used: runs * 900,
        tools_unused: runs * 1_500,
      },
      outputTokens: runs * 640,
      latencyMs: runs * 4_100,
      costUsd: Math.round(runs * 0.031 * 100) / 100,
      runs,
    };
  });
}

/** get_trace_health: the window's KPIs, and its per-day rows when includeDaily. */
export function traceHealth(days: number, seed = 13) {
  const random = seeded(seed);
  const start = Date.parse("2026-11-11T00:00:00Z") - (days - 1) * 86_400_000;
  const daily = Array.from({ length: days }, (_, index) => {
    const weekend = new Date(start + index * 86_400_000).getUTCDay() % 6 === 0;
    const traceCount = Math.round((weekend ? 140 : 420) * (0.8 + random() * 0.4));
    const totalTokens = traceCount * Math.round(14_000 + random() * 6_000);
    return {
      day: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
      traceCount,
      errorTraceCount: Math.round(traceCount * (0.02 + random() * 0.06)),
      averageLatencyMs: Math.round(3_000 + random() * 4_000),
      inputTokens: Math.round(totalTokens * 0.93),
      outputTokens: Math.round(totalTokens * 0.07),
      totalTokens,
      costUsd: Math.round(totalTokens * 0.0000031 * 100) / 100,
    };
  });
  const sum = (key: keyof (typeof daily)[number]) =>
    daily.reduce((total, row) => total + Number(row[key]), 0);
  const traceCount = sum("traceCount");
  const errorTraceCount = sum("errorTraceCount");
  return {
    kpis: {
      traceCount,
      errorTraceCount,
      errorRate: traceCount ? Math.round((errorTraceCount / traceCount) * 1e4) / 1e4 : 0,
      averageLatencyMs: traceCount ? 4_812.4 : null,
      p50LatencyMs: traceCount ? 3_406.1 : null,
      p95LatencyMs: traceCount ? 14_920.7 : null,
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      totalTokens: sum("totalTokens"),
      costUsd: Math.round(sum("costUsd") * 100) / 100,
    },
    daily,
  };
}

const hex = (random: () => number, length: number) =>
  Array.from({ length }, () => Math.floor(random() * 16).toString(16)).join("");
const uuid = (random: () => number) =>
  `${hex(random, 8)}-${hex(random, 4)}-4${hex(random, 3)}-a${hex(random, 3)}-${hex(random, 12)}`;
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)];

const TOOLS = [
  "lookup_order",
  "refund_payment",
  "send_email",
  "search_kb",
  "update_address",
  "cancel_subscription",
  "create_ticket",
  "get_invoice",
];
const TASK_NAMES = [
  "Issue a refund",
  "Track a parcel",
  "Update the address",
  "Cancel a plan",
  "Answer from the docs",
  "Escalate to a person",
  "Send an invoice",
  "Reset access",
];

/** list_tasks rows (lib/mcp/operations/loop: TaskRow & href). */
export function tasks(count: number, seed = 23) {
  const random = seeded(seed);
  const statuses = ["failing", "slow", "watch", "healthy", "healthy", "healthy"] as const;
  return Array.from({ length: count }, (_, index) => {
    const runs = Math.round(40 + random() * 900);
    const status = pick(random, statuses);
    const tool = pick(random, TOOLS);
    return {
      id: `task-${index + 1}`,
      name:
        TASK_NAMES[index % TASK_NAMES.length] +
        (index >= TASK_NAMES.length ? ` (${Math.floor(index / TASK_NAMES.length) + 1})` : ""),
      description: "What people ask the agent to get done, read from the tools its runs call.",
      icon: "wrench",
      color: null,
      status,
      runs,
      share: Math.round((runs / 6_000) * 1000) / 1000,
      finishRate:
        Math.round((status === "failing" ? 0.5 + random() * 0.2 : 0.78 + random() * 0.2) * 1000) /
        1000,
      weakest: {
        toolId: tool,
        label: tool,
        failures: Math.round(runs * 0.08),
        calls: runs,
        failureShare: 0.08,
      },
      correctionsPer100: index % 5 === 4 ? null : Math.round(random() * 180) / 10,
      topics: null,
      issues: status === "healthy" ? 0 : 1 + Math.floor(random() * 3),
      fixes: status === "healthy" ? 0 : Math.floor(random() * 3),
      fixesHref: `/projects/demo/fixes?task=task-${index + 1}`,
      href: `/projects/demo/tasks/task-${index + 1}`,
    };
  });
}

export function tasksResult(rows: ReturnType<typeof tasks>) {
  return {
    count: rows.length,
    tasks: rows,
    state: rows.length ? "ready" : "no_tasks",
    blocked: null,
    windowDays: 30,
    readAt: "2026-11-11T09:00:00Z",
    stats: {
      tasks: rows.length,
      runsInTasks: rows.reduce((sum, row) => sum + row.runs, 0),
      allRuns: 6_000,
      finishRate: 0.84,
      correctionsPer100: 6.2,
      correctionsRecorded: true,
    },
    unserved: { measured: true, runs: 0, asks: [] },
    readingSince: "2026-10-12",
    excludedRuns: 0,
  };
}

/** get_task: the row plus its steps, issues, fixes and example runs. */
export function taskDetail(
  task: ReturnType<typeof tasks>[number],
  steps = 4,
  seed = 29,
  estimatedCost = false,
) {
  const random = seeded(seed);
  return {
    task: {
      ...task,
      statusLine:
        task.status === "healthy"
          ? "Finishes as expected."
          : `${task.weakest.label} fails in ${Math.round(task.weakest.failureShare * 100)}% of calls.`,
      watch: task.status === "healthy" ? null : "step",
      windowDays: 30,
      readAt: "2026-11-11T09:00:00Z",
      finishedRuns: Math.round(task.runs * (task.finishRate ?? 0)),
      askedNoTool: 3,
      recoveredRuns: 12,
      medianMs: Math.round(2_000 + random() * 9_000),
      callsPerRun: Math.round((2 + random() * 4) * 10) / 10,
      // An estimated cost reads "~$0.04" on the task's page; a measured one "$0.04".
      cost: estimatedCost
        ? {
            kind: "estimated",
            perRun: 0.042,
            total: Math.round(task.runs * 0.042 * 100) / 100,
            callsPerRun: 3.4,
          }
        : {
            kind: "measured",
            perRun: 0.042,
            total: Math.round(task.runs * 0.042 * 100) / 100,
            runs: task.runs,
            modelCalls: task.runs * 3,
          },
      hasReading: true,
      order: { stability: 0.86, fixed: false },
      steps: TOOLS.slice(0, steps).map((toolId, position) => ({
        toolId,
        label: toolId,
        role: position < 2 ? "core" : "optional",
        position,
        runs: Math.round(task.runs * (1 - position * 0.15)),
        runShare: Math.round((1 - position * 0.15) * 1000) / 1000,
        calls: Math.round(task.runs * (1.1 - position * 0.15)),
        failures: Math.round(random() * 40),
        failureShare: Math.round(random() * 0.15 * 1000) / 1000,
        retries: Math.round(random() * 20),
        switches: 0,
        gaveUp: Math.round(random() * 5),
        medianMs: Math.round(80 + random() * 2_400),
        handoffMs: null,
        next: [],
        mark: position === 1 && task.status === "failing" ? "failing" : null,
      })),
      sideSteps: [],
      intents: null,
      corrections: null,
      issueList: Array.from({ length: Math.min(task.issues, steps) }, (_, index) => ({
        id: `issue-${index}`,
        kind: "tool_failure",
        title: `${TOOLS[index]} fails on retries`,
        figure: { display: "12%", caption: "of calls fail" },
        onTask: true,
        claim: "The tool returns an error the agent retries instead of reading.",
        whatToDo: "Make the error say what to change.",
        tools: [{ id: TOOLS[index], label: TOOLS[index] }],
      })),
      fixList: Array.from({ length: Math.min(task.fixes, steps) }, (_, index) => ({
        id: `fix-${index}`,
        kind: "fail-clearly",
        kindLabel: "Fail clearly",
        title: `Say why ${TOOLS[index]} failed`,
        tools: [{ id: TOOLS[index], label: TOOLS[index] }],
        href: `/projects/demo/fixes/fix-${index}`,
      })),
      allFixesHref: task.fixesHref,
      exampleRuns: Array.from({ length: Math.min(3, steps) }, (_, index) => ({
        runId: hex(random, 32),
        why: (["failed", "slow", "recent"] as const)[index],
        status: index === 0 ? "error" : "ok",
        startedAt: ago(30 + index * 50),
        calls: 4,
        failures: index === 0 ? 1 : 0,
        ask: [
          "Refund order 4821, it arrived broken",
          "Where is my parcel? It's been a week",
          "Can I get my money back for the extra charge?",
        ][index],
      })),
      scorers: [],
      scoreSeries: [],
      evalSet: null,
      shipments: null,
    },
  };
}

const FIX_KINDS = [
  ["fail-clearly", "Fail clearly"],
  ["rewrite", "Rewrite the description"],
  ["merge", "Merge tools"],
  ["schema", "Tighten the schema"],
  ["preload", "Preload context"],
  ["fewer-results", "Return fewer results"],
] as const;

/** list_fixes rows (FixRow). */
export function fixes(count: number, seed = 31) {
  const random = seeded(seed);
  return Array.from({ length: count }, (_, index) => {
    const [kind, kindLabel] = FIX_KINDS[index % FIX_KINDS.length];
    const tool = TOOLS[index % TOOLS.length];
    const applied = index % 4 === 3;
    const strength = pick(random, ["early", "solid", "strong"] as const);
    return {
      id: `fix-${index + 1}`,
      title: `${kindLabel}: ${tool}`,
      why: `${tool} is called on the wrong turns; the agent recovers by retrying, which costs a round trip.`,
      kind,
      kindLabel,
      status: applied ? "applied" : "open",
      effect:
        index % 5 === 4
          ? null
          : {
              value: `−${Math.round(2 + random() * 18)}% tokens`,
              detail: null,
              basis: index % 2 ? "replay" : "runs",
            },
      evidence: { strength, detail: `${Math.round(20 + random() * 300)} runs` },
      insightIds: [`insight-${index + 1}`],
      taskIds: [`task-${(index % 8) + 1}`],
      draft: null,
      tools: [tool],
      href: `/projects/demo/fixes/fix-${index + 1}`,
      source: {
        stage: "insights",
        kind: "insight",
        id: `insight-${index + 1}`,
        label: `${tool} fails`,
      },
      shipped: applied
        ? {
            version: 2,
            shippedAt: ago(60 * 24 * (index + 1)),
            shipmentId: `ship-${index}`,
            href: `/projects/demo/ship/ship-${index}`,
          }
        : null,
      evalBadge: null,
    };
  });
}

export function fixesResult(rows: ReturnType<typeof fixes>) {
  return {
    count: rows.length,
    fixes: rows,
    summary: {
      open: rows.filter((row) => row.status === "open").length,
      ready: 0,
      fromIssues: rows.length,
      issues: rows.length,
      tools: 6,
      roundTripsSaved: null,
      evidence: { early: 2, solid: 3, strong: 1, none: 0 },
      savings: {
        period: "month",
        periodLabel: "a month",
        total: {
          saved: { tokens: null, usd: null, ms: null },
          shareOfUsage: { tokens: null, usd: null, ms: null },
        },
        byTask: [],
      },
    },
  };
}

/** get_fix: the fix, its issues, experiments and shipments, and its lineage chain. */
export function fixDetail(fix: ReturnType<typeof fixes>[number], full = true) {
  const tool = fix.tools[0];
  return {
    fix: {
      ...fix,
      short: fix.kindLabel,
      change: {
        type: "agent_change",
        steps: [
          `Return a reason from ${tool} when it refuses.`,
          "Tell the agent to read it before retrying.",
        ],
        caveat: null,
      },
      copy: null,
      issues: full
        ? [
            {
              id: fix.insightIds[0],
              title: `${tool} fails on retries`,
              claim: "The agent retries instead of reading the error.",
              href: `/projects/demo/health#signal-${fix.insightIds[0]}`,
            },
          ]
        : [],
      appliedAt: fix.status === "applied" ? ago(60 * 24 * 3) : null,
    },
    chain: full
      ? [
          { stage: "monitor", kind: "trace", id: "4bf92f35", label: "Run 4bf92f35" },
          { stage: "insights", kind: "insight", id: fix.insightIds[0], label: `${tool} fails` },
          { stage: "improve", kind: "fix", id: fix.id, label: fix.title },
        ]
      : [],
    experiments: full
      ? [
          {
            id: "exp-1",
            name: `${tool} clearer errors`,
            fixId: fix.id,
            insightId: fix.insightIds[0],
            arms: { baseline: "v1", candidate: "v2" },
            trafficPercent: 20,
            status: "running",
            createdAt: ago(60 * 24 * 2),
            href: "/projects/demo/experiments/exp-1",
            source: null,
          },
        ]
      : [],
    shipments: full
      ? [
          {
            id: "ship-1",
            fixId: fix.id,
            insightId: fix.insightIds[0],
            experimentId: "exp-1",
            version: 2,
            notes: "Clearer refusal reasons",
            shippedAt: ago(60 * 24),
            source: null,
          },
        ]
      : [],
  };
}

const INSIGHT_KINDS = [
  "tool_failure",
  "slow_step",
  "unanswered",
  "retry_loop",
  "unused_tool",
] as const;

/** list_insights rows. */
export function insights(count: number, seed = 37) {
  const random = seeded(seed);
  return Array.from({ length: count }, (_, index) => {
    const tool = TOOLS[index % TOOLS.length];
    const kind = INSIGHT_KINDS[index % INSIGHT_KINDS.length];
    return {
      id: `insight-${index + 1}`,
      kind,
      title: {
        tool_failure: `${tool} fails`,
        slow_step: `${tool} is slow`,
        unanswered: "Asks go unanswered",
        retry_loop: `Retries on ${tool}`,
        unused_tool: `${tool} is never called`,
      }[kind],
      claim: "Seen across runs in the last 30 days.",
      cost: "About 4% of the window's tokens.",
      whatToDo: "Open the fix to see the change.",
      figure: { display: `${Math.round(random() * 30)}%`, caption: "of calls" },
      caveat: null,
      severity: Math.round(random() * 100) / 100,
      impact: Math.round(random() * 100) / 100,
      n: Math.round(10 + random() * 400),
      status: index % 6 === 5 ? "resolved" : "open",
      subject: { kind: "tool", key: tool, tools: [{ id: tool, name: tool }] },
      firstSeenAt: ago(60 * 24 * (10 + index)),
      lastSeenAt: ago(60 * (1 + index * 3)),
      href: `/projects/demo/health#signal-insight-${index + 1}`,
      source: { stage: "insights", kind: "insight", id: `insight-${index + 1}` },
    };
  });
}

const INSIGHT_TITLES: Record<string, string> = {
  tool_failure: "Retries after errors",
  slow_step: "Slow tool",
  unanswered: "Asks go unanswered",
  retry_loop: "Agent keeps correcting itself",
  unused_tool: "Tools nobody uses",
};

/**
 * list_insights' view model: Agent health's rows for these insights, one per
 * kind of issue, most points first (lib/mcp/operations/health.ts,
 * loadHealthIssueRows). The tool's data stays one insight each.
 */
export function insightRowsView(rows: ReturnType<typeof insights>) {
  const open = rows.filter((row) => row.status === "open");
  const kinds = [...new Set(open.map((row) => row.kind))];
  const grouped = kinds.map((kind, index) => {
    const members = open.filter((row) => row.kind === kind).sort((a, b) => b.severity - a.severity);
    const tools = [...new Set(members.map((row) => row.subject.key))];
    const points = Math.max(0, 7 - index * 2 - (members.length === 1 ? 1 : 0));
    return {
      key: kind,
      kind,
      title: INSIGHT_TITLES[kind] ?? kind,
      tone: index < 2 ? "fix_now" : index === kinds.length - 1 ? "early" : "watch",
      tools: {
        shown: tools.slice(0, 2).map((name) => [name]),
        more: Math.max(0, tools.length - 2),
        count: null,
      },
      scope: null,
      about:
        tools.length > 2
          ? `${tools.slice(0, 2).join(", ")} +${tools.length - 2}`
          : tools.join(", "),
      figure: members[0]!.figure,
      memberIds: members.map((row) => row.id),
      points: index === kinds.length - 1 ? null : points,
    };
  });
  const sure = grouped.filter((row) => row.tone !== "early").length;
  const tools = new Set(open.map((row) => row.subject.key)).size;
  return {
    kind: "health_issue_rows",
    rows: grouped,
    line: `${sure} ${sure === 1 ? "issue" : "issues"} across ${tools} ${tools === 1 ? "tool" : "tools"}, most points first.${grouped.length > sure ? ` ${grouped.length - sure} more is too early to call.` : ""}`,
  };
}

const SKILL_NAMES = [
  "refund-policy",
  "order-tracking",
  "address-change",
  "subscription-cancel",
  "kb-answering",
  "escalation",
  "invoice-requests",
  "password-reset",
  "tone-guide",
  "shipping-times",
];

/** list_skills rows. */
export function skills(count: number, seed = 41) {
  const random = seeded(seed);
  return Array.from({ length: count }, (_, index) => {
    const status = index % 7 === 6 ? "archived" : index % 4 === 3 ? "draft" : "published";
    const body =
      "When the customer asks for a refund, check the order first, then apply the policy below.";
    return {
      id: uuid(random),
      name:
        SKILL_NAMES[index % SKILL_NAMES.length] +
        (index >= SKILL_NAMES.length ? `-${Math.floor(index / SKILL_NAMES.length) + 1}` : ""),
      description: "How the support agent handles this kind of request.",
      searchableDescription: null as string | null,
      status,
      version: 1 + Math.floor(random() * 6),
      tags: ["support"],
      tools: [TOOLS[index % TOOLS.length]],
      endUserId: null,
      model: null as string | null,
      bodyPreview: body,
      bodyTruncated: false,
      bodyChars: body.length,
      createdAt: ago(60 * 24 * (40 + index)),
      updatedAt: ago(60 * (2 + index * 11)),
      publishedAt: status === "published" ? ago(60 * 24 * (index + 1)) : null,
    };
  });
}

export function skillDetail(skill: ReturnType<typeof skills>[number], empty = false) {
  const { bodyPreview, bodyTruncated: _t, bodyChars: _c, ...rest } = skill;
  return {
    skill: {
      ...rest,
      tags: empty ? [] : rest.tags,
      tools: empty ? [] : [...rest.tools, "search_kb"],
      metadata: {},
      body: bodyPreview,
    },
  };
}

/** list_shipments rows. */
export function shipments(count: number, seed = 43) {
  const random = seeded(seed);
  return Array.from({ length: count }, (_, index) => {
    const tool = pick(random, TOOLS);
    return {
      id: `ship-${index + 1}`,
      title: `v${count - index}: clearer errors from ${tool}`,
      shippedAt: ago(60 * 24 * index + Math.round(random() * 600)),
      href: `/projects/demo/ship/ship-${index + 1}`,
      source: {
        stage: "improve",
        kind: "fix",
        id: `fix-${index + 1}`,
        label: `Fail clearly: ${tool}`,
        href: `/projects/demo/fixes/fix-${index + 1}`,
      },
      trail: null,
    };
  });
}

const EVENT_TYPES = [
  ["search", "Search"],
  ["tool_call", "Tool call"],
  ["model_call", "Model call"],
] as const;

/** list_sdk_events rows (view events). */
export function sdkEvents(count: number, seed = 47, withheld = false) {
  const random = seeded(seed);
  return Array.from({ length: count }, (_, index) => {
    const [type, label] = EVENT_TYPES[index % EVENT_TYPES.length];
    const failed = random() < 0.08;
    return {
      identifier: `evt_${hex(random, 16)}`,
      type,
      label,
      subject:
        type === "search"
          ? withheld
            ? null
            : pick(random, [
                "refund for a broken item",
                "where is my order",
                "change delivery address",
              ])
          : type === "tool_call"
            ? pick(random, TOOLS)
            : "claude-sonnet-5-5",
      source: index % 3 === 0 ? "support-agent@1.4.2" : "billing-agent@0.9.0",
      sourceStatus: "active",
      at: ago(index * 3 + random() * 2),
      receivedAt: ago(index * 3),
      durationMs: Math.round(20 + random() * 1_800) as number | null,
      error: failed ? "timeout" : null,
      traceId: hex(random, 32),
      spanId: hex(random, 16),
      invocationId: null,
      values:
        type === "search"
          ? { hits: Math.round(random() * 40), topK: 8, inputTokens: null, outputTokens: null }
          : type === "model_call"
            ? {
                hits: null,
                topK: null,
                inputTokens: Math.round(3_000 + random() * 9_000),
                outputTokens: Math.round(200 + random() * 900),
              }
            : { hits: null, topK: null, inputTokens: null, outputTokens: null },
    };
  });
}

export function sdkEventsResult(rows: ReturnType<typeof sdkEvents>, withheld = false) {
  return {
    view: "events",
    range: "7d",
    summary: { received: rows.length, dropped: 0, rejected: 0, activeSources: rows.length ? 2 : 0 },
    verdict: rows.length ? "Events are arriving." : "No events in this range.",
    facets: null,
    events: rows,
    ...(withheld ? { contentWithheld: true } : {}),
  };
}

export function sdkEventDetail(event: ReturnType<typeof sdkEvents>[number], withheld = false) {
  const payload = withheld
    ? null
    : JSON.stringify({ type: event.type, subject: event.subject, values: event.values }, null, 2);
  return {
    event: withheld ? { ...event, subject: null } : event,
    payload,
    payloadChars: payload?.length ?? 0,
    ...(withheld ? { contentWithheld: true } : {}),
  };
}

const LOG_EVENTS = [
  ["ratel.search", "Search"],
  ["ratel.tool_pick", "Tool pick"],
  ["ratel.experiment.assign", "Experiment assignment"],
  ["ratel.feedback", "Feedback"],
] as const;

/** list_logs rows. */
export function logs(count: number, seed = 53, withheld = false) {
  const random = seeded(seed);
  return Array.from({ length: count }, (_, index) => {
    const [eventName, label] = LOG_EVENTS[index % LOG_EVENTS.length];
    const experiment = eventName === "ratel.experiment.assign";
    return {
      id: `log-${seed}-${index + 1}`,
      occurredAt: ago(index * 2 + random()),
      eventName,
      label,
      traceId: index % 5 === 4 ? null : hex(random, 32),
      spanId: index % 5 === 4 ? null : hex(random, 16),
      serviceName: index % 3 === 0 ? "billing-agent" : "support-agent",
      experimentName: experiment ? "rerank-v2" : null,
      experimentArm: experiment ? (index % 2 ? "candidate" : "baseline") : null,
      experimentRole: null,
      body: withheld
        ? null
        : eventName === "ratel.search"
          ? "query: refund for a broken item · 8 hits"
          : `${label} recorded`,
      attributes: withheld ? null : { "ratel.top_k": "8" },
      experimentAttributes: {},
      attributesCutAtIngest: false,
    };
  });
}

/** list_projects rows. */
export function projects(count: number, seed = 59) {
  const random = seeded(seed);
  const names = [
    "Support agent",
    "Billing agent",
    "Docs assistant",
    "Sales copilot",
    "Internal helpdesk",
    "Onboarding bot",
  ];
  return Array.from({ length: count }, (_, index) => {
    const name =
      names[index % names.length] +
      (index >= names.length ? ` ${Math.floor(index / names.length) + 1}` : "");
    return {
      id: uuid(random),
      name,
      slug: name.toLowerCase().replace(/\s+/g, "-"),
      organization: "acme",
      createdAt: ago(60 * 24 * (200 - index * 6)),
    };
  });
}

export function projectOverview(project: ReturnType<typeof projects>[number], ingested = true) {
  return {
    project: { id: project.id, name: project.name, slug: project.slug },
    hasIngestedTelemetry: ingested,
    counts: { skills: ingested ? 12 : 0, activeExperiments: ingested ? 2 : 0 },
  };
}

const OPERATION_NAMES = [
  "agent.turn",
  "llm.chat",
  "ratel.search",
  "tool lookup_order",
  "tool refund_payment",
  "tool send_email",
  "tool search_kb",
  "embedding.create",
];

/** list_span_groups rows (OperationAggregate). */
export function spanGroups(count: number, seed = 61) {
  const random = seeded(seed);
  return Array.from({ length: count }, (_, index) => {
    const calls = Math.round(50 + random() * 9_000);
    const errorCount = Math.round(calls * random() * 0.06);
    const p50 = Math.round(30 + random() * 2_000);
    return {
      key:
        OPERATION_NAMES[index % OPERATION_NAMES.length] +
        (index >= OPERATION_NAMES.length
          ? ` #${Math.floor(index / OPERATION_NAMES.length) + 1}`
          : ""),
      count: calls,
      errorCount,
      errorRate: Math.round((errorCount / calls) * 1e4) / 1e4,
      p50DurationMs: p50,
      p95DurationMs: Math.round(p50 * (2 + random() * 3)),
      p99DurationMs: Math.round(p50 * (4 + random() * 4)),
      costUsd: index % 3 === 1 ? Math.round(calls * 0.012 * 100) / 100 : 0,
      totalTokens: index % 3 === 1 ? calls * 11_000 : 0,
    };
  });
}

/** list_invoked_tools rows. */
export function invokedTools(count: number, seed = 67) {
  const random = seeded(seed);
  return Array.from({ length: count }, (_, index) => {
    const calls = Math.round(10 + random() * 4_000);
    const tokens = calls * Math.round(200 + random() * 3_000);
    return {
      name:
        TOOLS[index % TOOLS.length] +
        (index >= TOOLS.length ? `_v${Math.floor(index / TOOLS.length) + 1}` : ""),
      calls,
      tokens,
      costUsd: tokens * 0.000003,
      lastSeenAt: ago(index * 17 + random() * 30),
    };
  });
}

/** list_declared_tools rows. */
export function declaredTools(count: number, seed = 71) {
  const random = seeded(seed);
  return Array.from({ length: count }, (_, index) => {
    const name =
      TOOLS[index % TOOLS.length] +
      (index >= TOOLS.length ? `_v${Math.floor(index / TOOLS.length) + 1}` : "");
    const described = index % 5 !== 2;
    const calls = index % 6 === 5 ? 0 : Math.round(random() * 3_000);
    return {
      sourceId: index % 4 === 0 ? "billing-agent" : "support-agent",
      sourceStatus: index % 9 === 8 ? "stale" : "fresh",
      sourceLastSeenAt: ago(index * 5),
      factsStartedAt: ago(60 * 24 * 30),
      toolId: uuid(random),
      name,
      description: described
        ? `Looks up or changes ${name.replace(/_/g, " ")} for the customer.`
        : "",
      searchableDescription: null,
      inputSchema: null,
      outputSchema: null,
      metadata: null,
      calls,
      errors: Math.round(calls * random() * 0.05),
      lastUsedAt: calls ? ago(index * 23) : null,
      hasDescription: described,
    };
  });
}

export function declaredToolsResult(rows: ReturnType<typeof declaredTools>) {
  const undescribed = rows.filter((row) => !row.hasDescription).map((row) => row.name);
  return {
    count: rows.length,
    totalSynced: rows.length,
    undescribedCount: undescribed.length,
    undescribedTools: undescribed.slice(0, 25),
    tools: rows,
  };
}

/* - Custom monitoring (lib/mcp/operations/monitoring) ------------------------ */

const SCORER_NAMES = ["Fast enough", "Polite", "Cites a source", "No refund promised", "Short"];

export function scorers(count: number, seed = 31) {
  const random = seeded(seed);
  return Array.from({ length: count }, (_, index) => {
    const kind = index % 2 === 0 ? ("check" as const) : ("judge" as const);
    const scored = Math.round(random() * 900);
    const passRate = Math.round(random() * 1000) / 1000;
    const name = `${SCORER_NAMES[index % SCORER_NAMES.length]}${index < 5 ? "" : ` ${index}`}`;
    return {
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name,
      kind,
      summary:
        kind === "check"
          ? "Duration (ms) is at most 2000"
          : "Is the answer polite to the customer?",
      answers: "pass_or_fail",
      traces: index % 3 === 0 ? "Every trace" : "2 tasks",
      tasks: index % 3 === 0 ? null : ["t1", "t2"],
      sampleRate: kind === "check" ? 100 : 25,
      enabled: index % 4 !== 3,
      status: index % 4 === 3 ? "off" : "on",
      last7Days: { scored, passRate, average: passRate },
      result: `${Math.round(passRate * 100)}% passed, ${scored} results`,
      href: `/project/p1/scorers/${index}`,
    };
  });
}

export function scorerDetail(scorer: ReturnType<typeof scorers>[number], days = 14) {
  const random = seeded(scorer.name.length + days);
  return {
    summary: `${scorer.name} (${scorer.kind}, ${scorer.status}): ${scorer.result} in 7 days.`,
    scorer: {
      ...scorer,
      config: { path: "duration_ms", op: "lte", value: 2000 },
      filter: {},
      createdAt: "2026-11-01T09:00:00.000Z",
      updatedAt: "2026-11-09T09:00:00.000Z",
    },
    trend: Array.from({ length: days }, (_, index) => {
      const passRate = Math.round(random() * 1000) / 1000;
      return {
        day: new Date(NOW - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10),
        scored: Math.round(random() * 90),
        passRate,
        average: passRate,
      };
    }),
    latest: traces(days, 41).map((trace, index) => ({
      traceId: trace.traceId,
      traceStartedAt: trace.startedAt,
      scoredAt: trace.startedAt,
      result: index % 5 === 0 ? "Fail" : "Pass",
      value: index % 5 === 0 ? 0 : 1,
      passed: index % 5 !== 0,
      confidence: null,
      href: `/project/p1/traces/${trace.traceId}`,
    })),
  };
}

const ALERT_STATES = [
  { state: "alerting", status: "Alerting" },
  { state: "ok", status: "OK" },
  { state: "no_data", status: "No data" },
  { state: "ok", status: "Paused" },
  { state: "ok", status: "Needs attention" },
] as const;

export function alerts(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const { state, status } = ALERT_STATES[index % ALERT_STATES.length];
    return {
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: index === 0 ? "Too many errors" : `Slow answers ${index}`,
      condition:
        index % 2 === 0
          ? "Error rate is above 5% over 15 minutes"
          : "Latency p95 is above 4 s over 1 hour",
      operator: "above",
      threshold: index % 2 === 0 ? 0.05 : 4000,
      windowMinutes: index % 2 === 0 ? 15 : 60,
      unit: index % 2 === 0 ? "ratio" : "ms",
      enabled: status !== "Paused",
      state,
      status,
      problem: status === "Needs attention" ? "The query is invalid." : null,
      lastValue: state === "no_data" ? null : index % 2 === 0 ? 0.072 : 5200,
      lastValueText: state === "no_data" ? null : index % 2 === 0 ? "7.2%" : "5.2 s",
      stateChangedAt: new Date(NOW - index * 3_600_000).toISOString(),
      destinationCount: 1,
      href: `/project/p1/alerts/${index}`,
    };
  });
}

export function alertDetail(alert: ReturnType<typeof alerts>[number], changes = 4) {
  return {
    summary: `${alert.name} (${alert.status}): ${alert.condition}.`,
    alert: {
      ...alert,
      query: {
        version: 1,
        kind: "metric",
        measures: [{ measure: "error_rate", aggregation: "rate" }],
        dimensions: [],
        filters: {},
      },
      destinations: changes === 0 ? [] : [{ id: "d1", name: "#agent-alerts" }],
    },
    history: Array.from({ length: changes }, (_, index) => ({
      at: new Date(NOW - index * 5_400_000).toISOString(),
      from: index % 2 === 0 ? "ok" : "alerting",
      to: index % 2 === 0 ? "alerting" : "ok",
      value: index % 2 === 0 ? 0.072 : 0.02,
      valueText: index % 2 === 0 ? "7.2%" : "2%",
      condition: alert.condition,
      message: index % 2 === 0 ? "fire" : "recovery",
      delivery: "sent",
      sentTo: ["#agent-alerts"],
      error: null,
    })),
  };
}

export function alertDestinations(count: number) {
  return Array.from({ length: count }, (_, index) =>
    index % 3 === 1
      ? { id: `d${index}`, name: `Ops webhook ${index}`, kind: "webhook", lastFour: "a1b2" }
      : {
          id: `d${index}`,
          name: index === 0 ? "#agent-alerts" : `#team-${index}`,
          kind: "slack_channel",
          channelId: `C${String(index).padStart(10, "0")}`,
          warning: index % 3 === 2 ? "Invite the app to this channel." : null,
        },
  );
}

export function slackChannels(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `C${String(index).padStart(10, "0")}`,
    name: index === 0 ? "agent-alerts" : `team-${index}`,
    isPrivate: index % 4 === 3,
  }));
}

/** A project has five; more `copies` only fill a dense list. */
export function locationAttributes(prefix = "", copies = 1) {
  const five = [
    { key: "address", holds: "IP address, resolved and never stored", attribute: "client.address" },
    { key: "country", holds: "Country code (ISO 3166-1)", attribute: "geo.country.iso_code" },
    { key: "region", holds: "Region code (ISO 3166-2)", attribute: "geo.region.iso_code" },
    { key: "latitude", holds: "Latitude in degrees", attribute: "geo.location.lat" },
    { key: "longitude", holds: "Longitude in degrees", attribute: "geo.location.lon" },
  ];
  const rows = Array.from({ length: copies }, (_, copy) =>
    five.map((row) => ({
      ...row,
      key: copy ? `${row.key}_${copy}` : row.key,
      attribute: `${prefix}${row.attribute}`,
      source: prefix ? "custom" : "default",
    })),
  ).flat();
  return {
    rows,
    attributes: Object.fromEntries(rows.map(({ key, attribute }) => [key, attribute])),
    href: "/project/p1/settings/general",
  };
}

export function traceProperties(count: number) {
  const standard = [
    { name: "organization", column: null },
    { name: "release", column: null },
    { name: "user", column: "end_user_id" },
    { name: "session", column: "session_id" },
  ];
  const rows = Array.from({ length: count }, (_, index) => {
    const own = index >= standard.length;
    const state = own && index % 3 !== 0 ? "detected" : "indexed";
    return {
      name: own ? `app.key_${index}` : standard[index]!.name,
      state,
      source: own ? "user" : "standard",
      sourceMeans: own
        ? "your own: indexing it is a paid-plan feature"
        : "standard: Ratel indexes it on every plan",
      column: own ? null : standard[index]!.column,
      lastSeenAt: new Date(Date.UTC(2026, 10, 24, 12) - index * 3_600_000).toISOString(),
      seenCount: 1_000 - index * 7,
      valuesStored: state === "indexed" && (own || !standard[index]!.column),
    };
  });
  return {
    summary: `${rows.length} trace properties`,
    count: rows.length,
    rows,
    href: "/project/p1/settings",
  };
}

export function dashboards(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    name: index === 0 ? "Support agent" : `Board ${index}`,
    widgetCount: 8 - (index % 7),
    filters: {},
    range: null,
    updatedAt: new Date(NOW - index * 7_200_000).toISOString(),
    updatedBy: index % 2 === 0 ? "An agent (MCP)" : "Ann Example",
    href: `/project/p1/dashboards/${index}`,
  }));
}
