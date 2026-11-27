import assert from "node:assert/strict";
import type { SandboxRun, SandboxVersionSummary } from "@/lib/views/sandboxes";
import { createDrizzleCaseStore } from "../adapters/drizzle-case-store";
import { createDrizzleDatasetStore } from "../adapters/drizzle-dataset-store";
import { createDrizzleEvalStore } from "../adapters/drizzle-eval-store";
import { createDrizzleExperimentStore } from "../adapters/drizzle-experiment-store";
import type { DatasetDefinition, ResolvedRow } from "../domain/dataset";
import type { Experiment } from "../domain/experiment";
import { type ExperimentDeps, type StartEvalRun, startEvalRun } from "../experiments";
import type { DatasetSources } from "../ports/dataset-sources";
import {
  content,
  createEvalsDb,
  evalContent,
  modelDeps,
  ORGANIZATION_ID,
  PROJECT_ID,
} from "./support";

/** A database with fake sandboxes and fake dataset sources, for runs of one eval. */
export const SUBJECT = { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID };
const version = (id: string, name: string, params: string[] = ["tone", "model"]) =>
  ({
    id,
    projectId: PROJECT_ID,
    sandboxId: `${id.slice(0, 35)}0`,
    name,
    git: { commit: "b".repeat(40), dirty: false },
    status: "ready",
    createdAt: new Date(),
    tools: [],
    params: params.map((one) => ({
      name: one,
      type: "string",
      default: null,
      description: null,
      options: [],
    })),
  }) as SandboxVersionSummary;
export const SUPPORT = version("66666666-6666-4666-8666-666666666661", "support-demo");
export const SUPPORT_OLD = version("66666666-6666-4666-8666-666666666662", "support-demo");
export const BILLING = version("66666666-6666-4666-8666-666666666663", "billing-demo");
export const TURN = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;

function turnRow(turnId: string): ResolvedRow {
  return {
    name: "Case from a turn",
    content: content({ input: { message: `turn ${turnId.slice(-2)}` } }),
    sourceTurnId: turnId,
    sourceOutput: "recorded",
  };
}

export async function setup(sources: Partial<DatasetSources> = {}) {
  const { db } = await createEvalsDb();
  const calls: Array<[string, ...unknown[]]> = [];
  const started: Array<{ versionId: string; params: unknown }> = [];
  const trackedSources: Partial<DatasetSources> = {
    newestTurns: async (projectId, limit) => {
      calls.push(["newestTurns", projectId, limit]);
      return [TURN(1), TURN(2)].slice(0, limit);
    },
    taskTurns: async (projectId, taskId, limit) => {
      calls.push(["taskTurns", projectId, taskId, limit]);
      return [TURN(3)];
    },
    rqlTraces: async (projectId, text) => {
      calls.push(["rqlTraces", projectId, text]);
      return { ok: true, traceIds: ["t1", "t2"], truncated: false };
    },
    turnsOfTraces: async (_projectId, traceIds) => traceIds.map((_, n) => TURN(10 + n)),
    chooseCandidates: async () => [
      { turnId: TURN(20), taskId: "a", endedAt: new Date(1), failed: false, score: null },
      { turnId: TURN(21), taskId: "a", endedAt: new Date(2), failed: true, score: null },
    ],
    chooseForTask: async (_projectId, taskId, limit) => {
      calls.push(["chooseForTask", taskId, limit]);
      return [TURN(30)];
    },
    turnRow: async (_projectId, turnId) => (turnId === TURN(99) ? null : turnRow(turnId)),
    ...sources,
  };
  const deps: ExperimentDeps = {
    cases: createDrizzleCaseStore(db),
    evals: createDrizzleEvalStore(db),
    experiments: createDrizzleExperimentStore(db),
    ...modelDeps(db, { sources: trackedSources }),
    sandboxes: {
      enabled: async () => true,
      listVersions: async () => [SUPPORT, SUPPORT_OLD, BILLING],
      getVersion: async (projectId, id) =>
        [SUPPORT, SUPPORT_OLD, BILLING].find(
          (one) => one.id === id && one.projectId === projectId,
        ) ?? null,
      startRun: async (versionId, _input, options) => {
        started.push({ versionId, params: options.params });
        return {
          ok: true,
          run: { id: crypto.randomUUID(), projectId: PROJECT_ID, status: "running" } as SandboxRun,
        };
      },
      getRun: async () => null,
    },
    judge: {
      judge: { judgeFor: async () => null },
      limits: { dailyBudgetUsd: async () => 0 },
      budget: { hold: async () => false, settle: async () => {} },
      recordModelCall: () => {},
      now: () => new Date(),
    },
    now: () => new Date("2026-11-27T10:00:00Z"),
  };
  const datasets = createDrizzleDatasetStore(db);
  const dataset = async (name: string, definition: DatasetDefinition, projectId = PROJECT_ID) => {
    const made = await datasets.create({ projectId, name, definition, createdBy: "u" });
    assert.ok(typeof made === "object");
    return made;
  };
  const evalOn = async (name: string, over: Parameters<typeof evalContent>[0] = {}) => {
    const made = await createDrizzleEvalStore(db).create({
      projectId: PROJECT_ID,
      name,
      taskId: null,
      content: evalContent({ sandboxName: "support-demo", ...over }),
      createdBy: "u",
    });
    assert.ok(typeof made === "object", String(made));
    return made;
  };
  const run = (start: Omit<StartEvalRun, "startedBy">) =>
    startEvalRun(SUBJECT, { startedBy: "u", ...start }, deps);
  const started$ = async (start: Omit<StartEvalRun, "startedBy">): Promise<Experiment> => {
    const result = await run(start);
    assert.ok(result.ok, JSON.stringify(result));
    return result.experiment;
  };
  return { db, deps, calls, started, dataset, evalOn, run, start: started$ };
}
