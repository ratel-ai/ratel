import { z } from "zod";
import {
  enqueueJob as enqueueJobFn,
  findInFlightJob as findInFlightJobFn,
} from "@/lib/jobs/queries";
import { notFound } from "@/lib/mcp/errors";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { capRows, limitParam, TruncationTracker } from "@/lib/mcp/serialize";
import { APP_NAME } from "@/lib/platform/app-config";
import { toPythonStub, toToolJson, toTypeScriptStub } from "@/lib/synthesis/tool-crafter/export";
import {
  getCraftProposal,
  latestCraftRun,
  listCraftProposals,
} from "@/lib/synthesis/tool-crafter/queries";
import {
  CRAFT_STATUSES,
  type CraftedToolDefinition,
  type CraftKind,
} from "@/lib/synthesis/tool-crafter/types";
import { CRAFT_FIX_KIND, FIX_KIND_LABELS } from "@/lib/views/fixes/kinds";

/**
 * The fixes drafted from how the agent runs its tools, over MCP: list them,
 * read one, and queue a drafting run. The ids keep the names they shipped
 * with (`list_tool_crafts`, `get_tool_craft`, `generate_tool_crafts`); the
 * words are the product's (DESIGN.md): these are fixes, listed on Fixes beside
 * Quality's description rewrites. Ratel cannot change a tool in the
 * customer's runtime, so there is nothing to approve here: a fix is read and
 * made in the customer's code. Queuing a run makes no model call, which the
 * description says, so an agent does not have to guess what it costs.
 */
export interface ToolCrafterOperationDeps {
  latestRun: typeof latestCraftRun;
  listProposals: typeof listCraftProposals;
  getProposal: typeof getCraftProposal;
  findInFlightJob: typeof findInFlightJobFn;
  enqueueJob: typeof enqueueJobFn;
}

export const defaultToolCrafterDeps: ToolCrafterOperationDeps = {
  latestRun: latestCraftRun,
  listProposals: listCraftProposals,
  getProposal: getCraftProposal,
  findInFlightJob: findInFlightJobFn,
  enqueueJob: enqueueJobFn,
};

/** The plain kind of fix, as Fixes names it; the raw kind for one this build does not know. */
function kindLabelOf(kind: string): string {
  const fix = CRAFT_FIX_KIND[kind as CraftKind];
  return fix ? FIX_KIND_LABELS[fix] : kind;
}

function summary(
  row: Awaited<ReturnType<typeof listCraftProposals>>[number],
  tracker: TruncationTracker,
) {
  const crafted = row.crafted as unknown as CraftedToolDefinition[];
  return {
    id: row.id,
    /** The id Fixes opens it by (`/improvement/fixes?peek=<fixId>`). */
    fixId: `craft:${row.id}`,
    kind: row.kind,
    kindLabel: kindLabelOf(row.kind),
    status: row.status,
    sourceTools: row.sourceToolIds,
    craftedTools: crafted.map((c) => c.name),
    rationale: tracker.text(row.rationale, 300),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toolCrafterOperations(
  deps: ToolCrafterOperationDeps = defaultToolCrafterDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "list_tool_crafts",
      domain: "improvement",
      title: "List drafted fixes",
      description:
        "Fixes drafted by rules from how the agent runs its tools: merge tools it never runs apart, combine a task's steps into one tool, tighten a schema whose first calls fail, retire a tool nobody calls, rewrite a description searches miss. Each row has the kind of fix, the tools it changes, the drafted tool and its fixId on Fixes.",
      keywords: [
        "tool crafts",
        "crafted tools",
        "merge tools",
        "rewrite tool",
        "drafted fixes",
        "tool fixes",
        "tool",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        status: z.enum(CRAFT_STATUSES).optional(),
        limit: limitParam,
      }),
      async execute(ctx, params) {
        const tracker = new TruncationTracker();
        const [run, rows] = await Promise.all([
          deps.latestRun(ctx.projectId),
          deps.listProposals(ctx.projectId, {
            statuses: params.status ? [params.status] : undefined,
            limit: params.limit + 1,
          }),
        ]);
        const page = tracker.take(capRows(rows, params.limit));
        return {
          data: {
            lastRun: run
              ? {
                  status: run.status,
                  finishedAt: run.finishedAt?.toISOString() ?? null,
                  proposalsCreated: run.proposalsCreated,
                  declinedReason: run.declinedReason,
                }
              : null,
            count: page.length,
            crafts: page.map((row) => summary(row, tracker)),
          },
          truncated: tracker.value,
          hint: "get_tool_craft returns one fix in full, with the drafted definition as JSON and as TypeScript and Python stubs.",
        };
      },
    }),
    defineOperation({
      id: "get_tool_craft",
      domain: "improvement",
      title: "Get a drafted fix",
      description:
        "One drafted fix in full: the evidence, the tools as they are today, and the drafted definition (JSON, TypeScript and Python).",
      keywords: ["tool craft", "crafted definition", "drafted definition", "tool stub", "tool"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped, craftId: z.string().uuid() }),
      async execute(ctx, params) {
        const row = await deps.getProposal(ctx.projectId, params.craftId);
        if (!row) throw notFound("drafted fix");
        const crafted = row.crafted as unknown as CraftedToolDefinition[];
        return {
          data: {
            craft: {
              id: row.id,
              fixId: `craft:${row.id}`,
              kind: row.kind,
              kindLabel: kindLabelOf(row.kind),
              status: row.status,
              sourceTools: row.sourceDefinitions,
              hiddenTools: row.hiddenToolIds,
              rationale: row.rationale,
              details: row.details,
              expectedEffect: row.expectedEffect,
              migrationNotes: row.migrationNotes,
              evidence: row.evidence,
              crafted: crafted.map((tool) => ({
                definition: tool,
                json: toToolJson(tool),
                typescript: toTypeScriptStub(tool),
                python: toPythonStub(tool),
              })),
            },
          },
          hint: `${APP_NAME} cannot change a tool in the runtime; ship the drafted definition in your code.`,
        };
      },
    }),
  ];
}

/** The crafter's writes, assembled only when the registry includes writes. */
export function toolCrafterWriteOperations(
  deps: ToolCrafterOperationDeps = defaultToolCrafterDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "generate_tool_crafts",
      domain: "writes",
      title: "Draft fixes",
      description:
        "Queues a drafting run: rules read how the agent runs its tools, its tasks and the searches that missed a tool, and draft fixes (merges, combined steps, tighter schemas, prerequisites, rewrites, retirements and more). No model is called. Returns a jobId; poll get_job_status, then list_tool_crafts.",
      keywords: ["draft tool crafts", "draft fixes", "run crafter", "propose tool merges", "tool"],
      scope: "project",
      mutates: true,
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        const existing = await deps.findInFlightJob(ctx.projectId, "craft_tools");
        if (existing)
          return {
            data: { jobId: existing.id, coalesced: true },
            hint: "A run was already in flight; nothing new was started. Poll get_job_status with this jobId.",
          };
        const { id } = await deps.enqueueJob({
          projectId: ctx.projectId,
          kind: "craft_tools",
          payload: { trigger: "manual" },
        });
        return {
          data: { jobId: id, coalesced: false },
          hint: "Queued. Poll get_job_status with this jobId, then read the fixes with list_tool_crafts.",
        };
      },
    }),
  ];
}
