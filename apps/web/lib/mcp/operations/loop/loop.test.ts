import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { type DispatchSuccess, dispatchOperation } from "@/lib/mcp/dispatch";
import {
  defaultExperimentName,
  type LoopOperationDeps,
  loopReadOperations,
  loopWriteOperations,
} from "@/lib/mcp/operations/loop";
import type { InsightView } from "@/lib/mcp/operations/loop/read";
import { EvalGateError, type SimulationOutcome } from "@/lib/mcp/operations/loop/simulation";
import { buildRegistry } from "@/lib/mcp/registry";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite, organizations } from "@/lib/platform/db/test-support";
import { projects } from "@/lib/platform/projects/schema";
import { emptyChange } from "@/lib/views/eval-gate/change";
import { createFixShipment } from "@/lib/views/fixes/loop-queries";
import type { FixExperimentRow, FixShipmentRow } from "@/lib/views/fixes/schema";
import { fixStats } from "@/lib/views/fixes/select";
import type { Fix, FixesModel } from "@/lib/views/fixes/types";
import type { LineageRef } from "@/lib/views/lineage/types";

/**
 * The loop tools against injected reads: each result names its source one step
 * back, the chain walks to the trace, writes are scoped to a fix that exists in
 * the project, and every write emits its event.
 *
 * Owned (ADR-0030): the seven tools here; the task tools, task simulations
 * and fix drafts' cases land with the task loop and fix drafts.
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";
const INSIGHT = "22222222-2222-4222-8222-222222222222";
const EXPERIMENT = "33333333-3333-4333-8333-333333333333";
const SHIPMENT = "44444444-4444-4444-8444-444444444444";

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

const traceSource: LineageRef = {
  stage: "monitor",
  kind: "trace",
  id: "abc123",
  href: `/project/${PROJECT}/traces/abc123`,
};
const EVAL_SET = "55555555-5555-4555-8555-555555555555";
const EVAL_PAGE = `/project/${PROJECT}/improvement/fixes/${encodeURIComponent(`issue:${INSIGHT}`)}/eval`;

/** What RC-46's eval gate returns for a fix it simulated on 20 runs (the shape `run_eval` reads). */
function simulated(fixId: string, over: Partial<SimulationOutcome> = {}): SimulationOutcome {
  return {
    fixId,
    projectId: PROJECT,
    setId: EVAL_SET,
    runId: "66666666-6666-4666-8666-666666666666",
    status: "completed",
    label: "Simulated on 20 historical runs",
    nCases: 20,
    nSimulated: 20,
    before: { passed: 11, total: 20, passRate: 0.55, score: 0.6 },
    after: { passed: 18, total: 20, passRate: 0.9, score: 0.93 },
    verdict: "better",
    href: EVAL_PAGE,
    source: null,
    fix: { stage: "improve", kind: "fix", id: fixId },
    eval: {
      stage: "improve",
      kind: "eval",
      id: EVAL_SET,
      label: "Eval: Retry a failing tool",
      href: EVAL_PAGE,
    },
    error: null,
    ...over,
  };
}

const insight: InsightView = {
  id: INSIGHT,
  kind: "tool_errors",
  title: "Tool keeps failing",
  claim: "hold_fare fails in 31% of its calls.",
  cost: "41 failed calls this week.",
  whatToDo: "Retry hold_fare with backoff.",
  figure: { display: "31%", caption: "of calls" },
  caveat: null,
  severity: 0.3,
  impact: 41,
  n: 132,
  status: "open",
  subject: { kind: "tool", key: "hold_fare", tools: [{ id: "hold_fare", name: "hold_fare" }] },
  firstSeenAt: "2026-10-20T00:00:00.000Z",
  lastSeenAt: "2026-10-30T00:00:00.000Z",
  href: `/project/${PROJECT}/health#signal-${INSIGHT}`,
  source: traceSource,
};

const fix: Fix = {
  id: `issue:${INSIGHT}`,
  source: "issue",
  sourceId: INSIGHT,
  aliases: [`issue:${INSIGHT}`],
  title: "Retry hold_fare when it times out",
  short: "Retry a failing tool",
  why: "hold_fare fails in 31% of its calls.",
  kind: "reliability" as Fix["kind"],
  kindLabel: "Reliability",
  group: "agent" as Fix["group"],
  status: "open",
  subject: {
    tools: [{ id: "hold_fare", label: "hold_fare", href: "/catalog" }],
    tasks: [],
    topics: [],
  },
  effect: {
    value: "−41 failed calls",
    figure: "−41",
    unit: "failed calls",
    detail: "over 30 days",
    tone: "good",
    basis: "runs",
    also: [],
  },
  gain: null,
  evidence: { strength: "solid", label: "Solid", detail: "Seen 132 times" },
  issues: [
    {
      id: INSIGHT,
      kind: "tool_errors",
      title: "Tool keeps failing",
      claim: "hold_fare fails in 31% of its calls.",
      cost: "41 failed calls",
      figure: null,
      href: insight.href,
    },
  ],
  actions: {
    apply: false,
    dismiss: false,
    revert: false,
    catalogHref: null,
    copy: null,
    descriptionHref: null,
  },
  detail: { source: "issue", changes: ["Retry hold_fare with backoff."], caveat: null },
  rank: { tier: 1, score: 0.3, count: 41 },
  appliedAt: null,
};

const model: FixesModel = {
  projectId: PROJECT,
  open: [fix],
  applied: [],
  stats: {
    open: 1,
    ready: 0,
    fromIssues: 1,
    issues: 1,
    tools: 1,
    roundTripsSaved: null,
    savings: fixStats([]).savings,
    evidence: { early: 0, solid: 1, strong: 0, none: 0 },
  },
  failed: [],
  rewritesOn: false,
  overridesAdopted: null,
};

function experimentRow(over: Partial<FixExperimentRow> = {}): FixExperimentRow {
  return {
    id: EXPERIMENT,
    projectId: PROJECT,
    fixId: fix.id,
    insightId: INSIGHT,
    name: "fix-issue-22222222",
    baselineArm: "baseline",
    candidateArm: "fix",
    trafficPercent: 50,
    status: "running",
    createdBy: `project:${PROJECT}`,
    createdAt: new Date("2026-10-31T10:00:00.000Z"),
    ...over,
  };
}

interface Tracked {
  name: string;
  properties: Record<string, unknown>;
}

function deps(events: Tracked[], over: Partial<LoopOperationDeps> = {}): LoopOperationDeps {
  return {
    loadOpenInsights: async () => [insight],
    loadInsight: async (_projectId, id) => (id === INSIGHT ? insight : null),
    loadProjectFixes: async () => model,
    runSimulation: async (fixId) => simulated(fixId),
    latestEval: async (_projectId, f) => simulated(f.id),
    evalGateEnabled: async () => true,
    recordLineage: async (input) => input.object,
    createFixExperiment: async (input) => ({ row: experimentRow({ ...input }) }),
    getFixExperiment: async (_projectId, id) => (id === EXPERIMENT ? experimentRow() : null),
    listFixExperiments: async () => [],
    createFixShipment: async (input): Promise<FixShipmentRow> => ({
      id: SHIPMENT,
      liveMarkedBy: null,
      ...input,
      shippedAt: new Date("2026-10-31T11:00:00.000Z"),
    }),
    listFixShipments: async () => [],
    listProjectShipments: async () => [],
    trackServerEvent: (async (
      name: string,
      _context: unknown,
      properties: Record<string, unknown>,
    ) => {
      events.push({ name, properties });
    }) as LoopOperationDeps["trackServerEvent"],
    ...over,
  };
}

async function run(
  id: string,
  params: Record<string, unknown>,
  events: Tracked[] = [],
  over: Partial<LoopOperationDeps> = {},
) {
  const d = deps(events, over);
  return dispatchOperation(id, params, {
    registry: buildRegistry([...loopReadOperations(d), ...loopWriteOperations(d)]),
    auth,
  });
}

function data<T>(result: Awaited<ReturnType<typeof run>>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as DispatchSuccess).data as T;
}

test("list_insights returns insights with their trace as source", async () => {
  const out = data<{ count: number; insights: InsightView[] }>(await run("list_insights", {}));
  assert.equal(out.count, 1);
  assert.deepEqual(out.insights[0]!.source, traceSource);
});

test("list_insights filters by kind", async () => {
  const out = data<{ count: number }>(await run("list_insights", { kind: "slow_tool" }));
  assert.equal(out.count, 0);
});

test("list_fixes names the insight each fix resolves as its source", async () => {
  const out = data<{ fixes: { id: string; source: LineageRef; insightIds: string[] }[] }>(
    await run("list_fixes", { insightId: INSIGHT }),
  );
  assert.equal(out.fixes.length, 1);
  assert.deepEqual(out.fixes[0]!.source, {
    stage: "insights",
    kind: "insight",
    id: INSIGHT,
    label: "Tool keeps failing",
    href: insight.href,
  });
});

test("get_fix by insightId returns the change and the chain trace → insight → fix (oldest first)", async () => {
  const out = data<{ fix: { id: string; change: { steps: string[] } }; chain: LineageRef[] }>(
    await run("get_fix", { insightId: INSIGHT }),
  );
  assert.equal(out.fix.id, fix.id);
  assert.deepEqual(out.fix.change.steps, ["Retry hold_fare with backoff."]);
  assert.deepEqual(
    out.chain.map((ref) => ref.kind),
    ["trace", "insight", "fix"],
  );
});

test("get_fix needs fixId or insightId, and an unknown fix is not found", async () => {
  const none = await run("get_fix", {});
  assert.equal(none.ok, false);
  assert.equal((none as { error: string }).error, "invalid_params");
  const missing = await run("get_fix", { fixId: "craft:nope" });
  assert.equal((missing as { error: string }).error, "not_found");
});

test("run_eval goes through the eval gate as mcp in the background, reports before → after, chains the eval last, and emits fix_eval_run", async () => {
  const events: Tracked[] = [];
  let called: { fixId: string; trigger?: string; actor?: string; background?: boolean } | null =
    null;
  const out = data<{
    eval: {
      id: string;
      simulated: boolean;
      runs: number;
      verdict: string;
      label: string;
      before: { passRate: number };
      after: { passRate: number };
      href: string;
      source: LineageRef;
    };
    chain: LineageRef[];
  }>(
    await run("run_eval", { fixId: fix.id }, events, {
      runSimulation: async (fixId, options = {}) => {
        called = {
          fixId,
          trigger: options.trigger,
          actor: options.actor,
          background: options.background,
        };
        return simulated(fixId);
      },
    }),
  );
  assert.deepEqual(called, {
    fixId: fix.id,
    trigger: "mcp",
    actor: `project:${PROJECT}`,
    background: true,
  });
  assert.equal(out.eval.id, EVAL_SET);
  assert.equal(out.eval.simulated, true);
  assert.equal(out.eval.runs, 20);
  assert.equal(out.eval.label, "Simulated on 20 historical runs");
  assert.equal(out.eval.verdict, "better");
  assert.equal(out.eval.before.passRate, 0.55);
  assert.equal(out.eval.after.passRate, 0.9);
  assert.equal(out.eval.href, EVAL_PAGE);
  assert.equal(out.eval.source.kind, "fix");
  assert.deepEqual(
    out.chain.map((ref) => ref.kind),
    ["trace", "insight", "fix", "eval"],
  );
  assert.equal(out.chain.at(-1)!.href, EVAL_PAGE);
  assert.equal(events[0]!.name, "fix_eval_run");
  assert.equal(events[0]!.properties.simulated, true);
});

test("run_eval asks the eval gate for the caller in the project before simulating", async () => {
  const asked: [string, string][] = [];
  await run("run_eval", { fixId: fix.id }, [], {
    evalGateEnabled: async (projectId, actor) => {
      asked.push([projectId, actor]);
      return true;
    },
  });
  assert.deepEqual(asked, [[PROJECT, `project:${PROJECT}`]]);
});

test("run_eval refuses cleanly when the eval gate is off for the caller, and simulates nothing", async () => {
  const events: Tracked[] = [];
  let simulations = 0;
  const result = await run("run_eval", { fixId: fix.id }, events, {
    evalGateEnabled: async () => false,
    runSimulation: async (fixId) => {
      simulations += 1;
      return simulated(fixId);
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result, {
    ok: false,
    error: "forbidden",
    message: "The eval gate is off for this organization.",
    reason: "eval_gate_off",
  });
  assert.equal(simulations, 0);
  assert.equal(events.length, 0);
});

test("run_eval refuses a fix with nothing to simulate with why, and records no run (RC-77)", async () => {
  const events: Tracked[] = [];
  const result = await run("run_eval", { fixId: fix.id }, events, {
    runSimulation: async () => {
      throw new EvalGateError(
        "nothing-to-simulate",
        "There's no drafted text to replay yet. Run an analysis on Quality to draft one.",
      );
    },
  });
  assert.deepEqual(result, {
    ok: false,
    error: "conflict",
    message:
      "This fix has nothing to simulate yet, so no eval was queued. There's no drafted text to replay yet. Run an analysis on Quality to draft one.",
    reason: "nothing_to_simulate",
  });
  assert.equal(events.length, 0);
  // A fix the gate doesn't know is still not found.
  const missing = await run("run_eval", { fixId: fix.id }, [], {
    runSimulation: async () => {
      throw new EvalGateError("fix-not-found", "This fix isn't open in the project any more.");
    },
  });
  assert.equal((missing as { error: string }).error, "not_found");
});

test("run_eval says plainly when nothing was simulated", async () => {
  const out = data<{ eval: { simulated: boolean; runs: number; verdict: string } }>(
    await run("run_eval", { fixId: fix.id }, [], {
      runSimulation: async (fixId) =>
        simulated(fixId, {
          nSimulated: 0,
          before: null,
          after: null,
          verdict: "unsupported",
          label: "Simulated on 0 historical runs",
        }),
    }),
  );
  assert.equal(out.eval.simulated, false);
  assert.equal(out.eval.runs, 0);
  assert.equal(out.eval.verdict, "unsupported");
});

test("run_eval returns at once while the simulation is queued, and tells the agent to poll get_eval, not to call run_eval again", async () => {
  const events: Tracked[] = [];
  const result = await run("run_eval", { fixId: fix.id }, events, {
    runSimulation: async (fixId) =>
      simulated(fixId, {
        status: "queued",
        nSimulated: 0,
        before: null,
        after: null,
        verdict: null,
      }),
  });
  const out = data<{
    eval: {
      status: string;
      simulated: boolean;
      verdict: string;
      href: string;
      pollAfterSeconds: number;
    };
  }>(result);
  assert.equal(out.eval.status, "queued");
  assert.equal(out.eval.simulated, false);
  assert.equal(out.eval.verdict, "pending");
  assert.equal(out.eval.href, EVAL_PAGE);
  assert.ok(out.eval.pollAfterSeconds > 0);
  const hint = (result as DispatchSuccess & { hint?: string }).hint ?? "";
  assert.match(hint, /get_eval/);
  assert.match(hint, /Do not call run_eval again/);
  assert.equal(events[0]!.properties.status, "queued");
});

test("get_eval reads the fix's latest simulation without starting one", async () => {
  let simulations = 0;
  const out = data<{ eval: { status: string; verdict: string; before: { passRate: number } } }>(
    await run("get_eval", { fixId: fix.id }, [], {
      runSimulation: async (fixId) => {
        simulations += 1;
        return simulated(fixId);
      },
    }),
  );
  assert.equal(simulations, 0);
  assert.equal(out.eval.status, "completed");
  assert.equal(out.eval.verdict, "better");
  assert.equal(out.eval.before.passRate, 0.55);
});

test("get_eval says when the fix was never simulated, and refuses when the eval gate is off", async () => {
  const never = data<{ eval: null }>(
    await run("get_eval", { fixId: fix.id }, [], { latestEval: async () => null }),
  );
  assert.equal(never.eval, null);
  const off = await run("get_eval", { fixId: fix.id }, [], { evalGateEnabled: async () => false });
  assert.equal((off as { error: string }).error, "forbidden");
});

test("an unreliable replay reports no before and after, and is not a simulation", async () => {
  const out = data<{
    eval: {
      simulated: boolean;
      verdict: string;
      before: unknown;
      after: unknown;
      fidelity: { matched: number; total: number };
    };
  }>(
    await run("get_eval", { fixId: fix.id }, [], {
      latestEval: async (_projectId, f) =>
        simulated(f.id, {
          verdict: "unreliable",
          methods: {
            rerank: 0,
            replay: 2,
            none: 18,
            reasons: [],
            fidelity: { matched: 0, total: 20 },
          },
        }),
    }),
  );
  assert.equal(out.eval.simulated, false);
  assert.equal(out.eval.verdict, "unreliable");
  assert.equal(out.eval.before, null);
  assert.equal(out.eval.after, null);
  assert.deepEqual(out.eval.fidelity, { matched: 0, total: 20 });
});

test("run_eval turns the eval gate's not-found into the tool's not_found", async () => {
  const result = await run("run_eval", { fixId: fix.id }, [], {
    runSimulation: async () => {
      throw new EvalGateError("fix-not-found", "This fix isn't open in the project any more.");
    },
  });
  assert.equal((result as { error: string }).error, "not_found");
});

test("create_experiment stores the fix and insight, records its lineage, returns the span attributes, and emits", async () => {
  const events: Tracked[] = [];
  const recorded: { object: LineageRef; source: LineageRef }[] = [];
  const out = data<{
    experiment: { name: string; insightId: string; source: LineageRef };
    runtime: { spanAttributes: Record<string, unknown> };
    chain: LineageRef[];
  }>(
    await run("create_experiment", { fixId: fix.id }, events, {
      recordLineage: async (input) => {
        recorded.push(input);
        return input.object;
      },
    }),
  );
  assert.deepEqual(
    recorded.map((link) => [link.object.kind, link.object.id, link.source.kind]),
    [
      ["fix", fix.id, "insight"],
      ["experiment", "fix-issue-22222222", "fix"],
    ],
  );
  assert.deepEqual(
    out.chain.map((ref) => ref.kind),
    ["trace", "insight", "fix", "experiment"],
  );
  assert.equal(out.chain.at(-1)!.href, `/project/${PROJECT}/calibration/~fix-issue-22222222`);
  assert.equal(out.experiment.name, "fix-issue-22222222");
  assert.equal(out.experiment.insightId, INSIGHT);
  assert.equal(out.experiment.source.kind, "fix");
  assert.equal(out.runtime.spanAttributes["ratel.experiment.id"], "fix-issue-22222222");
  assert.equal(events[0]!.name, "fix_experiment_created");
});

test("create_experiment refuses a taken name and identical arms", async () => {
  const taken = await run("create_experiment", { fixId: fix.id, name: "taken" }, [], {
    createFixExperiment: async () => ({ duplicate: true }),
  });
  assert.equal((taken as { error: string }).error, "invalid_params");
  const same = await run("create_experiment", {
    fixId: fix.id,
    baselineArm: "a",
    candidateArm: "a",
  });
  assert.equal((same as { error: string }).error, "invalid_params");
});

test("mark_fix_shipped stores the version linked to fix, insight and experiment, with the full chain", async () => {
  const events: Tracked[] = [];
  const recorded: { object: LineageRef; source: LineageRef }[] = [];
  const out = data<{
    shipment: {
      version: string;
      fixId: string;
      insightId: string;
      experimentId: string;
      source: LineageRef;
      fix: LineageRef;
      insight: LineageRef;
    };
    chain: LineageRef[];
  }>(
    await run(
      "mark_fix_shipped",
      { fixId: fix.id, version: "v1.4.2", experimentId: EXPERIMENT },
      events,
      {
        recordLineage: async (input) => {
          recorded.push(input);
          return input.object;
        },
      },
    ),
  );
  assert.deepEqual(
    recorded.map((link) => [link.object.kind, link.object.id, link.source.kind, link.source.id]),
    [
      ["fix", fix.id, "insight", INSIGHT],
      ["shipment", SHIPMENT, "experiment", "fix-issue-22222222"],
    ],
  );
  assert.equal(out.shipment.version, "v1.4.2");
  assert.equal(out.shipment.fixId, fix.id);
  assert.equal(out.shipment.insightId, INSIGHT);
  assert.equal(out.shipment.experimentId, EXPERIMENT);
  assert.equal(out.shipment.source.kind, "experiment");
  assert.equal(out.shipment.fix.kind, "fix");
  assert.equal(out.shipment.insight.id, INSIGHT);
  assert.deepEqual(
    out.chain.map((ref) => ref.stage),
    ["monitor", "insights", "improve", "improve", "ship"],
  );
  assert.deepEqual(
    out.chain.map((ref) => ref.kind),
    ["trace", "insight", "fix", "experiment", "shipment"],
  );
  assert.equal(out.chain.at(-1)!.href, `/project/${PROJECT}/ship?peek=${SHIPMENT}`);
  assert.equal(events[0]!.name, "fix_shipped");
});

test("mark_fix_shipped without an experiment has the fix as source", async () => {
  const out = data<{ shipment: { source: LineageRef } }>(
    await run("mark_fix_shipped", { fixId: fix.id, version: "abc1234" }),
  );
  assert.equal(out.shipment.source.kind, "fix");
});

test("a fix that names no insight, intent or task records no source of its own, so the spine can still derive its insight", async () => {
  const PROPOSAL = "55555555-5555-4555-8555-555555555555";
  const craft: Fix = {
    ...fix,
    id: `craft:${PROPOSAL}`,
    source: "craft",
    sourceId: PROPOSAL,
    aliases: [`craft:${PROPOSAL}`],
    issues: [],
  };
  const loadProjectFixes = async () => ({ ...model, open: [craft] });
  const recorded: { object: LineageRef; source: LineageRef }[] = [];
  const recordLineage = async (input: { object: LineageRef; source: LineageRef }) => {
    recorded.push(input);
    return input.object;
  };

  const experiment = data<{ chain: LineageRef[] }>(
    await run("create_experiment", { fixId: craft.id }, [], { loadProjectFixes, recordLineage }),
  );
  const shipped = data<{ chain: LineageRef[] }>(
    await run("mark_fix_shipped", { fixId: craft.id, version: "v3" }, [], {
      loadProjectFixes,
      recordLineage,
    }),
  );
  assert.deepEqual(
    recorded.map((link) => [link.object.kind, link.source.kind]),
    [
      ["experiment", "fix"],
      ["shipment", "fix"],
    ],
    "no fix → metric link is stored",
  );
  // The tool's own answer still says where the fix came from.
  assert.equal(experiment.chain[0]!.kind, "metric");
  assert.equal(shipped.chain[0]!.kind, "metric");

  // A fix that names a task records it.
  recorded.length = 0;
  const task = {
    id: "t-book",
    label: "Book a flight",
    color: null,
    href: `/project/${PROJECT}/tasks/t-book`,
  };
  const withTask: Fix = { ...craft, subject: { ...craft.subject, tasks: [task] } };
  data(
    await run("mark_fix_shipped", { fixId: craft.id, version: "v4" }, [], {
      loadProjectFixes: async () => ({ ...model, open: [withTask] }),
      recordLineage,
    }),
  );
  assert.deepEqual(
    recorded.map((link) => [link.object.kind, link.source.kind, link.source.id]),
    [
      ["fix", "task", "t-book"],
      ["shipment", "fix", craft.id],
    ],
  );
});

test("mark_fix_shipped refuses an experiment of another fix", async () => {
  const result = await run(
    "mark_fix_shipped",
    { fixId: fix.id, version: "v2", experimentId: EXPERIMENT },
    [],
    {
      getFixExperiment: async () => experimentRow({ fixId: "craft:other" }),
    },
  );
  assert.equal((result as { error: string }).error, "not_found");
});

test("the default experiment name is a slug of the fix", () => {
  assert.equal(
    defaultExperimentName({ id: "x", source: "craft", sourceId: "AB-12_cd/ef9" }),
    "fix-craft-ab12cdef",
  );
});

test("list_fixes and get_fix report a fix's shipped state once mark_fix_shipped recorded it (RC-72)", async () => {
  const older: FixShipmentRow = {
    liveMarkedBy: null,
    id: "77777777-7777-4777-8777-777777777777",
    projectId: PROJECT,
    fixId: fix.id,
    insightId: INSIGHT,
    experimentId: null,
    version: "v2.4.0",
    notes: null,
    shippedBy: `project:${PROJECT}`,
    shippedAt: new Date("2026-10-30T09:00:00.000Z"),
  };
  const newest: FixShipmentRow = {
    ...older,
    id: SHIPMENT,
    version: "v2.5.0",
    shippedAt: new Date("2026-10-31T11:00:00.000Z"),
  };
  const shipped = {
    version: "v2.5.0",
    shippedAt: "2026-10-31T11:00:00.000Z",
    shipmentId: SHIPMENT,
    href: `/project/${PROJECT}/ship?peek=${SHIPMENT}`,
  };

  const listed = data<{ fixes: { id: string; status: string; shipped: unknown }[] }>(
    await run("list_fixes", {}, [], { listProjectShipments: async () => [newest, older] }),
  );
  assert.deepEqual(listed.fixes[0]!.shipped, shipped, "the newest shipment's version and time");
  assert.equal(listed.fixes[0]!.status, "open", "status keeps its meaning; shipped is beside it");

  const one = data<{ fix: { shipped: unknown }; shipments: { version: string }[] }>(
    await run("get_fix", { fixId: fix.id }, [], { listFixShipments: async () => [newest, older] }),
  );
  assert.deepEqual(one.fix.shipped, shipped);
  assert.deepEqual(
    one.shipments.map((row) => row.version),
    ["v2.5.0", "v2.4.0"],
  );

  // Shipped under an id later merged into the fix: list_fixes and get_fix agree.
  const merged = { ...newest, fixId: "craft:merged-away" };
  const aliased = { ...model, open: [{ ...fix, aliases: [...fix.aliases, "craft:merged-away"] }] };
  const both = {
    loadProjectFixes: async () => aliased,
    listProjectShipments: async () => [merged],
  };
  assert.equal(
    data<{ fixes: { shipped: { version: string } }[] }>(await run("list_fixes", {}, [], both))
      .fixes[0]!.shipped.version,
    "v2.5.0",
  );
  assert.equal(
    data<{ fix: { shipped: { version: string } } }>(
      await run("get_fix", { fixId: fix.id }, [], both),
    ).fix.shipped.version,
    "v2.5.0",
  );

  // A failed shipments read costs the field, never the tool.
  const failing = { listProjectShipments: async () => Promise.reject(new Error("timeout")) };
  assert.equal(
    data<{ fixes: { shipped: unknown }[] }>(await run("list_fixes", {}, [], failing)).fixes[0]!
      .shipped,
    null,
  );
  assert.equal(
    data<{ fix: { shipped: unknown } }>(await run("get_fix", { fixId: fix.id }, [], failing)).fix
      .shipped,
    null,
  );

  const none = data<{ fixes: { shipped: unknown }[] }>(await run("list_fixes", {}));
  assert.equal(none.fixes[0]!.shipped, null, "not shipped: null");
});
