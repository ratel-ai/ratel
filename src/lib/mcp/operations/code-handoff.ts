import { z } from "zod";
import { forbidden, invalidParams, notFound } from "@/lib/mcp/errors";
import { mcpActor, mcpEventContext } from "@/lib/mcp/operations/health";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { codeHandoffEnabledForActor } from "@/lib/views/code-handoff/gate";
import { type HandoffFixDeps, handoffFix } from "@/lib/views/code-handoff/handoff/handoff-fix";
import { PUBLIC_REPO_MESSAGE } from "@/lib/views/code-handoff/handoff/view";
import { handoffFixDeps } from "@/lib/views/code-handoff/handoff/wiring";

/**
 * Code handoff over MCP (RC-918): `handoff_fix` hands a fix to Claude Code
 * through a GitHub issue in the project's linked repo, as Hand off does on a
 * fix's page. Behind `FF_CODE_HANDOFF`, decided for the bearer as the
 * other gated tools do (`codeHandoffEnabledForActor`).
 */

export interface CodeHandoffOperationDeps {
  /** The handoff's dependencies for this project and bearer; null when the project has no organization. */
  handoffDeps: (projectId: string, actor: string) => Promise<HandoffFixDeps | null>;
}

const defaultDeps: CodeHandoffOperationDeps = {
  handoffDeps: async (projectId, actor) => {
    const organization = await getOrganizationByProjectId(projectId);
    if (!organization) return null;
    return handoffFixDeps({
      organization,
      flagEnabled: (id) => codeHandoffEnabledForActor(id, actor),
    });
  },
};

const FLAG_OFF =
  "Handing off fixes is off for this project (FF_CODE_HANDOFF). get_flag_status lists what is on.";
const NO_REPO =
  "No GitHub repository is linked to this project. Link one in Project settings › Repository, then call handoff_fix again.";

export function codeHandoffOperations(
  deps: CodeHandoffOperationDeps = defaultDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "handoff_fix",
      domain: "writes",
      title: "Hand off a fix to Claude Code",
      description:
        "Hand a fix to Claude Code. This tool changes something: it opens a GitHub issue that mentions @claude in the project's linked repository, with the fix's brief and its ratel-fix marker. A second call returns the first issue. Needs a linked private repository: a public one is refused, because the brief holds trace data. Get the fixId from list_fixes or get_fix.",
      keywords: [
        "hand off",
        "handoff",
        "github issue",
        "claude code",
        "open a pull request",
        "coding agent",
      ],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        fixId: z
          .string()
          .min(1)
          .max(200)
          .describe(
            "A fix id from list_fixes or get_fix, e.g. issue:<uuid>, craft:<uuid>, rewrite:<uuid>.",
          ),
      }),
      async execute(ctx, params) {
        const actor = mcpActor(ctx.auth, ctx.projectId);
        const handoffDeps = await deps.handoffDeps(ctx.projectId, actor);
        if (!handoffDeps) throw notFound("project");
        const result = await handoffFix(
          {
            projectId: ctx.projectId,
            fixId: params.fixId,
            handedOffBy: actor,
            context: mcpEventContext(ctx),
            surface: "mcp",
          },
          handoffDeps,
        );
        if (!result.ok) {
          if (result.error === "flag_off") throw forbidden(FLAG_OFF);
          if (result.error === "no_repo_linked") throw invalidParams(NO_REPO);
          if (result.error === "public_repo") throw invalidParams(PUBLIC_REPO_MESSAGE);
          throw notFound("fix");
        }
        return {
          data: {
            handoff: {
              fixId: result.fixId,
              target: result.target,
              url: result.url,
              issueNumber: result.externalId,
              created: result.created,
            },
          },
          hint: result.created
            ? "Claude Code picks the issue up and opens a pull request. list_shipments shows the fix once its change is deployed."
            : "This fix was already handed off: this is its issue. Nothing new was opened.",
        };
      },
    }),
  ];
}
