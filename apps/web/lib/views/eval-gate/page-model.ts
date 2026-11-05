import { getDb } from "@/lib/platform/db/client";
import { loadCatalogNames } from "@/lib/readings/trace-signals/signals/analysis-context";
import { describeChange, describeReplay, parseChange } from "@/lib/views/eval-gate/change";
import { describeExpected } from "@/lib/views/eval-gate/defaults";
import { judgeLine } from "@/lib/views/eval-gate/judge";
import { methodForKind, nothingToSimulate } from "@/lib/views/eval-gate/method";
import { type ReplayPathsView, replayPathsOf } from "@/lib/views/eval-gate/replay-paths";
import type { EvalDb } from "@/lib/views/eval-gate/runs";
import { resolveFixChange } from "@/lib/views/eval-gate/seams";
import { badgeOf, fixSource, methodOfRun, roleOf } from "@/lib/views/eval-gate/service";
import {
  getEvalSet,
  listCases,
  listEvalRuns,
  parseBreakdown,
  parseEvidence,
  parseJudge,
  parseMethods,
  parseResults,
  parseStatus,
  parseTally,
  parseVerdict,
} from "@/lib/views/eval-gate/store";
import {
  CASE_ORIGIN_LABELS,
  type CaseResult,
  type CaseRole,
  type EvalBadge,
  type EvalCase,
  type EvalRunStatus,
  type MethodTally,
  SIM_METHOD_LABELS,
  type SimMethod,
  type SimulationSummary,
  SKIP_REASON_LABELS,
  type Tally,
  type Verdict,
} from "@/lib/views/eval-gate/types";
import type { Fix } from "@/lib/views/fixes/types";
import { type LineageRef, parseLineageRef } from "@/lib/views/lineage/types";

/**
 * Everything the eval page renders, as plain serializable data: the fix, its
 * set's runs with what each should do and what the latest simulation found,
 * the change in words and the earlier simulations.
 */

export interface EvalCaseRow extends EvalCase {
  originLabel: string;
  expectedText: string;
  runHref: string;
  traceHref: string | null;
  result: CaseResult | null;
  skippedLabel: string | null;
  /** RC-61: graded (holdout) or the insight's own run (shown apart). */
  role: CaseRole;
  /** How the latest simulation read this run, in words ("Model replay"), and what it had to stand in for. */
  methodLabel: string | null;
  methodNote: string | null;
  /** RC-76: what the latest replay of this run did, next to what the run did; null when it wasn't replayed. */
  replayPaths: ReplayPathsView | null;
}

export interface EvalRunSummary {
  id: string;
  status: EvalRunStatus;
  verdict: Verdict | null;
  before: Tally | null;
  after: Tally | null;
  nCases: number;
  nSimulated: number;
  interval: { low: number; high: number } | null;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  /** RC-61 (null on older simulations). */
  evidence: SimulationSummary["evidence"];
  breakdown: SimulationSummary["breakdown"];
  methods: MethodTally | null;
  method: SimMethod | "mixed" | null;
  /** The judge's status in words: "Criteria not judged: no model configured". */
  judge: string | null;
  /** Whether model replay was on for it. */
  replay: boolean;
}

export interface EvalGatePageModel {
  projectId: string;
  fixId: string;
  /** The fix as Fixes shows it; null when it is no longer open (the set stays readable). */
  fix: { id: string; short: string; kindLabel: string; href: string } | null;
  source: LineageRef | null;
  /**
   * RC-77: how this fix's kind is simulated, known before any run (the set's
   * method once it has one), so the page never names a method the fix won't use.
   */
  method: SimMethod;
  /** RC-77: why "Run simulation" is disabled (the fix has nothing to simulate); null when it can run. */
  blocked: string | null;
  set: {
    id: string;
    title: string;
    targetRuns: number;
    change: string[];
    unsupportedReason: string | null;
    /** RC-61: how this kind of fix is simulated, and what a replay applies. */
    method: SimMethod;
    replayChange: string[];
    holdoutRuns: number;
    evidenceRuns: number;
  } | null;
  cases: EvalCaseRow[];
  badge: EvalBadge;
  latest: EvalRunSummary | null;
  history: EvalRunSummary[];
  /** Catalog tools for the expected-tool picker: id and name. */
  tools: { id: string; name: string }[];
}

function summaryOf(run: Awaited<ReturnType<typeof listEvalRuns>>[number]): EvalRunSummary {
  const interval =
    run.interval && typeof run.interval === "object"
      ? (run.interval as { low?: unknown; high?: unknown })
      : null;
  return {
    id: run.id,
    status: parseStatus(run.status),
    verdict: parseVerdict(run.verdict),
    before: parseTally(run.before),
    after: parseTally(run.after),
    nCases: run.nCases,
    nSimulated: run.nSimulated,
    interval:
      interval && typeof interval.low === "number" && typeof interval.high === "number"
        ? { low: interval.low, high: interval.high }
        : null,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    error: run.error,
    evidence: parseEvidence(run.evidence),
    breakdown: parseBreakdown(run.breakdown),
    methods: parseMethods(run.methods),
    method: methodOfRun(run),
    judge: judgeLine(parseJudge(run.judge)),
    replay: run.replay,
  };
}

/** A change the simulator can't apply is never simulated, whatever its kind asks for. */
function plannedMethod(kind: string, unsupportedReason: string | null): SimMethod {
  return unsupportedReason ? "none" : methodForKind(kind);
}

export async function loadEvalGatePage(
  projectId: string,
  fixId: string,
  fix: Fix | null,
  db: EvalDb = getDb(),
  actor?: string,
): Promise<EvalGatePageModel> {
  const root = `/project/${encodeURIComponent(projectId)}`;
  const canonical = fix?.id ?? fixId;
  const [set, names] = await Promise.all([
    getEvalSet(projectId, canonical, db),
    loadCatalogNames(projectId, db),
  ]);
  const tools = [...names]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const resolved = fix ? await resolveFixChange(projectId, fix, { db, actor }) : null;
  const blocked = fix && resolved ? nothingToSimulate(fix.kind, resolved.change) : null;
  const fixModel = fix
    ? {
        id: fix.id,
        short: fix.short,
        kindLabel: fix.kindLabel,
        href: `${root}/improvement/fixes?peek=${encodeURIComponent(fix.id)}`,
      }
    : null;
  if (!set) {
    const method: SimMethod =
      fix && resolved ? plannedMethod(fix.kind, resolved.change.unsupportedReason) : "none";
    return {
      projectId,
      fixId: canonical,
      fix: fixModel,
      source: fix ? fixSource(fix) : null,
      method,
      blocked,
      set: null,
      cases: [],
      badge: { state: "none" },
      latest: null,
      history: [],
      tools,
    };
  }
  const [cases, runs] = await Promise.all([listCases(set.id, db), listEvalRuns(set.id, 10, db)]);
  const latestRow = runs[0] ?? null;
  const completed = runs.find((run) => run.status === "completed") ?? null;
  const results = new Map(
    parseResults(completed?.results).map((result) => [result.caseId, result]),
  );
  const change = parseChange(set.change);
  const evidence = new Set(set.evidenceTurnIds ?? []);
  const roles = new Map(cases.map((item) => [item.id, roleOf(item, evidence)]));
  const evidenceRuns = [...roles.values()].filter((role) => role === "evidence").length;
  const method = plannedMethod(set.fixKind, change.unsupportedReason);
  return {
    projectId,
    fixId: set.fixId,
    fix: fixModel,
    source: parseLineageRef(set.source) ?? (fix ? fixSource(fix) : null),
    method,
    blocked,
    set: {
      id: set.id,
      title: set.title,
      targetRuns: set.targetRuns,
      change: describeChange(change, names),
      unsupportedReason: change.unsupportedReason,
      method,
      replayChange: describeReplay(change, names),
      holdoutRuns: cases.length - evidenceRuns,
      evidenceRuns,
    },
    cases: cases.map((item) => {
      const result = results.get(item.id) ?? null;
      return {
        ...item,
        originLabel: CASE_ORIGIN_LABELS[item.origin],
        expectedText: describeExpected(item.expected, names),
        runHref: `${root}/traces/turns/${encodeURIComponent(item.turnId)}`,
        traceHref: item.traceId ? `${root}/traces/${encodeURIComponent(item.traceId)}` : null,
        result,
        skippedLabel: result?.skipped ? SKIP_REASON_LABELS[result.skipped] : null,
        role: roles.get(item.id) ?? "holdout",
        methodLabel: result?.method ? SIM_METHOD_LABELS[result.method] : null,
        methodNote: result?.methodNote ?? null,
        replayPaths: replayPathsOf(result),
      };
    }),
    badge: badgeOf(set, latestRow),
    latest: completed ? summaryOf(completed) : null,
    history: runs.map(summaryOf),
    tools,
  };
}

export { type ReplayPathsView, replayPathsOf } from "@/lib/views/eval-gate/replay-paths";
