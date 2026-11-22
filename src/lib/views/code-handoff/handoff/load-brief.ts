import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { getAgentHealthLimits } from "@/lib/platform/entitlements";
import type { Organization } from "@/lib/platform/organizations";
import { publicBaseUrl } from "@/lib/platform/public-url";
import { loadFixes } from "@/lib/views/fixes/load";
import type { Fix } from "@/lib/views/fixes/types";
import { readIssueExamples, turnsPerIssue } from "@/lib/views/health/issue-examples";
import { getRepoLink, listCodePointers } from "../store";
import { type BriefEvalSet, type CodePointer, handoffBrief } from "./brief";

/**
 * The handoff brief's inputs for one fix id (RC-916): the fix as Fixes builds
 * it, the linked repo's code pointers that name it, example traces of its
 * issues, and its eval set. Each read is a dependency, so tests use fakes.
 *
 * Owned (ADR-0030): the eval set is upstream's newest eval-set simulation of the fix
 * (`mcp/operations/loop/eval-set.ts`), which reads the Evals area; the Evals product area is not
 * part of this port, so the default has none and the brief says so.
 */

export interface LoadBriefDeps {
  loadFixes: (input: {
    projectId: string;
    organization: Organization;
  }) => Promise<{ open: Fix[]; applied: Fix[] }>;
  /** The linked repo's pointers; empty without a link. */
  codePointers: (projectId: string) => Promise<CodePointer[]>;
  /** Trace ids of example turns of these issues, within the plan's limits. */
  exampleTraceIds: (
    projectId: string,
    organization: Organization,
    issueIds: readonly string[],
  ) => Promise<string[]>;
  evalSet: (projectId: string, fixId: string) => Promise<BriefEvalSet | null>;
  consoleBaseUrl: () => string;
}

export interface LoadedBrief {
  fix: Fix;
  brief: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const defaultLoadBriefDeps: LoadBriefDeps = {
  loadFixes: (input) => loadFixes({ ...input, topics: false }),
  codePointers: async (projectId) => {
    const link = await getRepoLink(projectId);
    if (!link) return [];
    return (await listCodePointers(link.id)).map(({ kind, symbol, path, line }) => ({
      kind,
      symbol,
      path,
      line,
    }));
  },
  exampleTraceIds: async (projectId, organization, issueIds) => {
    const limits = getAgentHealthLimits(organization);
    const perIssue = turnsPerIssue(limits.agentHealthEvidenceTurns);
    if (perIssue <= 0 || issueIds.length === 0) return [];
    const examples = await withStatementTimeout(
      (db) =>
        readIssueExamples(db, projectId, issueIds, {
          perIssue,
          shown: limits.agentHealthSignalsShown,
        }),
      {
        operation: "handoff_brief_issue_examples",
      },
    );
    return examples.flatMap((example) =>
      example.turns.flatMap((turn) => (turn.traceId ? [turn.traceId] : [])),
    );
  },
  // No Evals area here: no eval-set simulation to name.
  evalSet: async () => null,
  consoleBaseUrl: publicBaseUrl,
};

/** The brief for one fix of the project, or null when the project has no such fix. */
export async function loadHandoffBrief(
  input: { projectId: string; organization: Organization; fixId: string },
  deps: LoadBriefDeps = defaultLoadBriefDeps,
): Promise<LoadedBrief | null> {
  const { projectId, organization, fixId } = input;
  const model = await deps.loadFixes({ projectId, organization });
  const fix = [...model.open, ...model.applied].find(
    (candidate) => candidate.id === fixId || candidate.aliases.includes(fixId),
  );
  if (!fix) return null;
  const issueIds = fix.issues.map((issue) => issue.id).filter((id) => UUID.test(id));
  const [pointers, traceIds, evalSet] = await Promise.all([
    deps.codePointers(projectId),
    deps.exampleTraceIds(projectId, organization, issueIds),
    deps.evalSet(projectId, fix.id),
  ]);
  const brief = handoffBrief({
    fix,
    pointers: relevantPointers(fix, pointers),
    traceIds,
    evalSet,
    craftPrompt: fix.source === "craft" ? (fix.actions.copy?.text ?? null) : null,
    projectId,
    consoleBaseUrl: deps.consoleBaseUrl(),
  });
  return { fix, brief };
}

/**
 * The pointers this fix needs: the definitions of its own tools, and every
 * model id and system prompt (where the agent is configured). Tool pointers of
 * other tools are noise for this change.
 */
export function relevantPointers(fix: Fix, pointers: readonly CodePointer[]): CodePointer[] {
  const tools = new Set(fix.subject.tools.flatMap((tool) => [tool.id, tool.label]));
  return pointers.filter((pointer) => pointer.kind !== "tool" || tools.has(pointer.symbol));
}
