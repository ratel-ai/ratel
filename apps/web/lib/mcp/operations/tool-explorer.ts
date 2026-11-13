import { z } from "zod";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { capRows, limitParam, TruncationTracker } from "@/lib/mcp/serialize";
import {
  latestExplorerRun,
  listCousage,
  listIntentTools,
  listMergeCandidates,
  listTransitions,
  MERGE_MIN_JACCARD_LOW,
  MERGE_MIN_SUPPORT,
} from "@/lib/readings/tool-explorer/queries";
import {
  EXPLORER_SCOPES,
  type ExplorerEdge,
  type ExplorerSet,
} from "@/lib/readings/tool-explorer/types";

/**
 * Which tools the agent runs together, from the latest reading of the tools
 * behind each task (the `explore_tool_usage` job): co-used sets, each named
 * after its task when its tools are the task's steps, and what runs after a
 * given tool. Read-only; on for every project.
 */
export interface ToolExplorerOperationDeps {
  latestRun: typeof latestExplorerRun;
  listTransitions: typeof listTransitions;
  listCousage: typeof listCousage;
  listMergeCandidates: typeof listMergeCandidates;
  listIntentTools: typeof listIntentTools;
}

export const defaultToolExplorerDeps: ToolExplorerOperationDeps = {
  latestRun: latestExplorerRun,
  listTransitions,
  listCousage,
  listMergeCandidates,
  listIntentTools,
};

const scopeParam = z.enum(EXPLORER_SCOPES as [string, ...string[]]).default("turn");

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function edgeView(edge: ExplorerEdge) {
  return {
    from: edge.a,
    to: edge.b,
    n: edge.n,
    of: edge.nA,
    p: round(edge.p),
    pLow: round(edge.pLow),
    pHigh: round(edge.pHigh),
    lift: round(edge.lift),
    reverseN: edge.reverseN,
  };
}

function setView(set: ExplorerSet) {
  return {
    tools: set.items,
    support: set.support,
    share: round(set.share),
    ...(set.size === 2
      ? {
          jaccard: round(set.jaccard ?? 0),
          jaccardLow: round(set.jaccardLow ?? 0),
          pAGivenB: round(set.pBa ?? 0),
          pBGivenA: round(set.pAb ?? 0),
        }
      : {}),
    workflowId: set.workflowId,
    taskId: set.workflowId,
  };
}

async function runFacts(deps: ToolExplorerOperationDeps, projectId: string) {
  const run = await deps.latestRun(projectId, undefined, "completed");
  if (!run) return null;
  const summary = run.summary as {
    units?: Record<string, { units: number; multiUnits: number }>;
  } | null;
  return {
    computedAt: run.finishedAt?.toISOString() ?? null,
    windowDays: run.windowDays,
    turnsScanned: run.turnsScanned,
    sessionsScanned: run.sessionsScanned,
    units: summary?.units ?? null,
  };
}

const NO_RUN_HINT =
  "No reading yet for this project. A reading follows each Agent health run once the project has closed runs; the console lists the project's tasks under Agent health, Tasks.";

export function toolExplorerOperations(
  deps: ToolExplorerOperationDeps = defaultToolExplorerDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "list_tool_cousage",
      domain: "improvement",
      title: "List tool co-usage",
      description:
        "Tools that run together in the same turn or the same session, from real invocations: each set with how many units ran it, the task it is when its tools are a task's steps (taskId), and for pairs the overlap and each direction's conditional share. mergeCandidatesOnly keeps the pairs the agent never runs apart.",
      keywords: [
        "tools used together",
        "co-usage",
        "tool pairs",
        "tool sets",
        "always together",
        "tasks",
        "task steps",
        "tool",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        scope: scopeParam.describe(
          "turn: tools called in one turn; session: tools called anywhere in one session.",
        ),
        size: z
          .number()
          .int()
          .min(2)
          .max(8)
          .optional()
          .describe(
            "Only sets of exactly this many tools (sets reach as many tools as the biggest task).",
          ),
        minSupport: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Only sets seen in at least this many units."),
        tool: z.string().min(1).max(200).optional().describe("Only sets containing this tool id."),
        mergeCandidatesOnly: z
          .boolean()
          .default(false)
          .describe(
            `Only pairs with Jaccard lower bound >= ${MERGE_MIN_JACCARD_LOW} and support >= ${MERGE_MIN_SUPPORT}.`,
          ),
        limit: limitParam,
      }),
      async execute(ctx, params) {
        const run = await runFacts(deps, ctx.projectId);
        if (!run) return { data: { run: null, count: 0, sets: [] }, hint: NO_RUN_HINT };
        const tracker = new TruncationTracker();
        const scope = params.scope as "turn" | "session";
        const rows = params.mergeCandidatesOnly
          ? await deps.listMergeCandidates(ctx.projectId, {
              scope,
              minSupport: params.minSupport,
              limit: params.limit + 1,
            })
          : await deps.listCousage(ctx.projectId, {
              scope,
              size: params.size,
              minSupport: params.minSupport,
              tool: params.tool,
              limit: params.limit + 1,
            });
        const page = tracker.take(capRows(rows, params.limit));
        return {
          data: { run, scope, count: page.length, sets: page.map(setView) },
          truncated: tracker.value,
          hint: "list_tool_transitions says what the agent runs after a given tool, the order of a task's steps.",
        };
      },
    }),
    defineOperation({
      id: "list_tool_transitions",
      domain: "improvement",
      title: "List tool transitions",
      description:
        "What the agent runs after a given tool, from real invocations: next-tool probabilities with confidence bounds and lift, in one turn or across a session, the order a task's steps run in. kind=next is the call right after; kind=before is any later call in the same unit.",
      keywords: [
        "what runs after",
        "next tool",
        "transitions",
        "tool sequence",
        "tool order",
        "task steps",
        "tool",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        scope: scopeParam,
        kind: z.enum(["next", "before"]).default("next"),
        from: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Only transitions leaving this tool id."),
        to: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Only transitions arriving at this tool id."),
        minN: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Only transitions seen at least this many times."),
        limit: limitParam,
      }),
      async execute(ctx, params) {
        const run = await runFacts(deps, ctx.projectId);
        if (!run) return { data: { run: null, count: 0, transitions: [] }, hint: NO_RUN_HINT };
        const tracker = new TruncationTracker();
        const rows = await deps.listTransitions(ctx.projectId, {
          scope: params.scope as "turn" | "session",
          kind: params.kind,
          from: params.from,
          to: params.to,
          minN: params.minN,
          limit: params.limit + 1,
        });
        const page = tracker.take(capRows(rows, params.limit));
        return {
          data: {
            run,
            scope: params.scope,
            kind: params.kind,
            count: page.length,
            transitions: page.map(edgeView),
          },
          truncated: tracker.value,
          hint: "p is n / of: for kind=next, the share of the from tool's calls whose next call was the to tool; for kind=before, the share of units calling from that later called to.",
        };
      },
    }),
    defineOperation({
      id: "list_intent_tool_usage",
      domain: "improvement",
      title: "List intent tool usage",
      description:
        "Which tools serve each kind of search the agent makes: for every intent grouped from real search queries, the tools the agent went on to call in the same turn or session, as a share of that intent's units with a confidence bound. Rows group by intent, biggest first.",
      keywords: [
        "tools per intent",
        "intent to tool",
        "which tool serves",
        "intents",
        "searches",
        "tool",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        scope: scopeParam,
        intentId: z
          .string()
          .uuid()
          .optional()
          .describe("Only this intent: an intentId from an earlier page of this list."),
        minUnits: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Only intents carried by at least this many units."),
        limit: limitParam,
      }),
      async execute(ctx, params) {
        const run = await runFacts(deps, ctx.projectId);
        if (!run) return { data: { run: null, count: 0, intents: [] }, hint: NO_RUN_HINT };
        const tracker = new TruncationTracker();
        const rows = await deps.listIntentTools(ctx.projectId, {
          scope: params.scope as "turn" | "session",
          intentId: params.intentId,
          minUnits: params.minUnits,
          limit: params.limit + 1,
        });
        const page = tracker.take(capRows(rows, params.limit));
        const byIntent = new Map<
          string,
          {
            intentId: string;
            text: string | null;
            units: number;
            tools: { tool: string; n: number; share: number; shareLow: number }[];
          }
        >();
        for (const row of page) {
          let intent = byIntent.get(row.intentId);
          if (!intent) {
            intent = {
              intentId: row.intentId,
              text: row.intentText === null ? null : tracker.text(row.intentText, 300),
              units: row.intentUnits,
              tools: [],
            };
            byIntent.set(row.intentId, intent);
          }
          intent.tools.push({
            tool: row.toolId,
            n: row.n,
            share: round(row.share),
            shareLow: round(row.shareLow),
          });
        }
        return {
          data: { run, scope: params.scope, count: page.length, intents: [...byIntent.values()] },
          truncated: tracker.value,
          hint: "Rows are intent-tool pairs; the last intent on a truncated page may be missing some of its tools. Pass an intent's intentId to read all of its tools.",
        };
      },
    }),
  ];
}
